const { google } = require('googleapis');
const { isHorarioValido, minutosAteHorario } = require('../utils/parseHorario');

const PROG_WIDE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const MONITOR_SHEET_ID   = '1RusxsxP7g-PKVJX5b8qPrl_VojLhvflXqdLOQlk88EQ';
const LOADER_SHEET_ID    = '1xCDNq3dOlFiKdu9ucGa2utuzqsZA4kNEo8Ep2-7autk';

// ─── SINGLETON SHEETS CLIENT ──────────────────────────────────────────────────
// Reutiliza autenticação e client entre requisições (otimização: evita
// recriar GoogleAuth + sheets client a cada chamada).
let _sheetsClient = null;

function getSheets() {
  if (!_sheetsClient) {
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    _sheetsClient = google.sheets({ version: 'v4', auth });
  }
  return _sheetsClient;
}

// ─── CACHE EM MEMÓRIA ─────────────────────────────────────────────────────────
// TTL de 25 s: elimina reads redundantes em burst (múltiplas abas, reloads,
// múltiplos monitores) sem afetar o ciclo normal de 30 s do frontend.
let _voosCache      = null;
let _voosCacheExpiry = 0;
const CACHE_TTL_MS  = 25_000;

function normalizarTipoOperacao(valor) {
  const s = String(valor || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .trim();
  return s === 'SAIDA' ? 'SAIDA' : 'CHEGADA';
}

function extrairHorario(valor) {
  const texto = String(valor || '').trim();
  const match = texto.match(/([01]\d|2[0-3]):[0-5]\d/);
  return match ? match[0] : '';
}

// Para ETD do monitor_saidas: se o valor vier com data ("07/07/2026 11:00:00"),
// valida se é hoje antes de extrair o horário.
// Hoje → retorna HH:MM. Outro dia → retorna "DD/MM" (falha isHorarioValido, voo sai do painel).
// Sem data → comportamento normal de extrairHorario.
function extrairHorarioETD(valor) {
  const texto = String(valor || '').trim();
  const comData = texto.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (comData) {
    const isoValor = `${comData[3]}-${comData[2]}-${comData[1]}`;
    const hojeBR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const hojeISO = [
      hojeBR.getFullYear(),
      String(hojeBR.getMonth() + 1).padStart(2, '0'),
      String(hojeBR.getDate()).padStart(2, '0'),
    ].join('-');
    if (isoValor !== hojeISO) return `${comData[1]}/${comData[2]}`; // ex: "07/07" → inválido
  }
  return extrairHorario(texto);
}

function calcTipoSolo(sta, std) {
  if (!sta || !std) return null;
  const [hSta, mSta] = sta.split(':').map(Number);
  const [hStd, mStd] = std.split(':').map(Number);
  let diff = (hStd * 60 + mStd) - (hSta * 60 + mSta);
  if (diff < 0) diff += 1440;
  return diff <= 180 ? 'TRÂNSITO' : 'NORMAL';
}

// Reconhece: CANCELADO, CANCEL, CANC, CXL, CNX (com ou sem espaços)
const TERMOS_CANCELAMENTO = ['CANCEL', 'CANC', 'CXL', 'CNX'];

function isCancelado(...valores) {
  return valores.some(v => {
    const texto = String(v || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .trim()
      .toUpperCase();
    if (!texto) return false;
    return TERMOS_CANCELAMENTO.some(t => texto.includes(t));
  });
}

// Aceita DD/MM/YYYY, DD-MM-YYYY e YYYY-MM-DD → devolve YYYY-MM-DD
function normalizarDataISO(valor) {
  const texto = String(valor || '').trim();
  // DD/MM/YYYY
  const brSlash = texto.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (brSlash) return `${brSlash[3]}-${brSlash[2]}-${brSlash[1]}`;
  // YYYY-MM-DD (já ISO — checar antes de DD-MM-YYYY)
  const iso = texto.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return texto;
  // DD-MM-YYYY
  const brDash = texto.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (brDash) return `${brDash[3]}-${brDash[2]}-${brDash[1]}`;
  return '';
}

function isHojeFlexivel(data) {
  const isoStr = normalizarDataISO(data);
  if (!isoStr) return false;
  const hojeBR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const hojeISO = [
    hojeBR.getFullYear(),
    String(hojeBR.getMonth() + 1).padStart(2, '0'),
    String(hojeBR.getDate()).padStart(2, '0'),
  ].join('-');
  return isoStr === hojeISO;
}

// "TP0089" → { code:"TP", numero:"89" }
// "TP89"   → { code:"TP", numero:"89" }
// "0951"   → { code:"",   numero:"951" }
// "89"     → { code:"",   numero:"89"  }
function normalizarVoo(rawVoo) {
  const texto = String(rawVoo || '').trim().toUpperCase();
  const comCode = texto.match(/^([A-Z0-9]*[A-Z])(\d+)$/);
  if (comCode) {
    return { code: comCode[1], numero: String(parseInt(comCode[2], 10)) };
  }
  if (/^\d+$/.test(texto)) {
    return { code: '', numero: String(parseInt(texto, 10)) };
  }
  return { code: '', numero: texto };
}

function estaNaJanelaOperacional(horario) {
  const tempo = minutosAteHorario(horario);
  if (tempo === null || tempo === undefined) return false;
  return tempo <= 90; // entrada: até 1h30 de antecedência
}

// ─── LOADER ──────────────────────────────────────────────────────────────────
// B(1)=CHEGADA/SAÍDA  E(4)=DATA  F(5)=VOO  K(10)=SLA
// M(12)=Nº LOADER 1   N(13)=OPERADOR 1   O(14)=CHEGADA OP 1
// R(17)=Nº LOADER 2   S(18)=OPERADOR 2   T(19)=CHEGADA OP 2
async function getLoaderPlanilha() {
  const sheets = getSheets();
  const response = await sheets.spreadsheets.values.get(
    { spreadsheetId: LOADER_SHEET_ID, range: 'LOADER!A:T' },
    { timeout: 10000 }
  );

  const rows = response.data.values;
  if (!rows || rows.length < 2) return [];

  return rows.slice(1)
    .map(row => ({
      tipoOperacao: normalizarTipoOperacao(row[1]),
      data:         String(row[4]  || '').trim(),
      voo:          String(row[5]  || '').trim(),
      sla:          extrairHorario(row[10]),
      loader1:      String(row[12] || '').trim(),
      operador1:    String(row[13] || '').trim(),
      chegadaOp1:   extrairHorario(row[14]),
      loader2:      String(row[17] || '').trim(),
      operador2:    String(row[18] || '').trim(),
      chegadaOp2:   extrairHorario(row[19]),
    }))
    .filter(r => r.voo && r.data);
}

function calcLoaderAndon(loader) {
  const escalado   = (loader.loader1   || loader.loader2)   && (loader.operador1 || loader.operador2);
  const posicionado = escalado && (loader.chegadaOp1 || loader.chegadaOp2);

  if (posicionado) return 'VERDE';

  const minSLA = loader.sla ? (minutosAteHorario(loader.sla) ?? null) : null;

  if (minSLA !== null && minSLA <= 5)  return 'VERMELHO';
  if (minSLA !== null && minSLA <= 10) return 'AMARELO_PISCANDO';
  if (minSLA !== null && minSLA <= 15) return 'AMARELO';
  if (escalado) return 'AZUL';
  return 'CINZA';
}

const COMPANHIAS_CARGUEIRAS = ['M3', '5Y', 'CV', 'UC', 'QT', 'L7', 'GT', 'SID', 'WD', 'ZC'];

function isCargueira(voo) {
  const v = String(voo || '').trim().toUpperCase();
  return COMPANHIAS_CARGUEIRAS.some(prefix => v.startsWith(prefix));
}

// ─── PROG WIDE ──────────────────────────────────────────────────────────────
// Chegadas: A(0)=DATA  B(1)=VOO  C(2)=ORIGEM  D(3)=STA
// Saídas:   W(22)=DATA  X(23)=VOO  Y(24)=DES  Z(25)=STD
// Cancel:   K(10)=OBSERVAÇÃO chegada  AG(32)=OBSERVAÇÃO saída
async function getProgWide() {
  const sheets = getSheets();
  const response = await sheets.spreadsheets.values.get(
    { spreadsheetId: PROG_WIDE_SHEET_ID, range: 'PROG WIDE!A:AG' },
    { timeout: 10000 }
  );

  const rows = response.data.values;
  if (!rows || rows.length < 2) return [];

  const resultado = [];

  for (const row of rows.slice(1)) {
    const canceladoChegada = isCancelado(row[10]); // coluna K (OBSERVAÇÃO)
    const canceladoSaida   = isCancelado(row[32]); // coluna AG (OBSERVAÇÃO)

    const sta      = extrairHorario(row[3]);  // coluna D
    const std      = extrairHorario(row[25]); // coluna Z
    const tipoSolo = calcTipoSolo(sta, std);

    // Chegada
    const vooChegada = String(row[1] || '').trim(); // coluna B
    if (!canceladoChegada && vooChegada && !isCargueira(vooChegada)) {
      resultado.push({
        tipoOperacao: 'CHEGADA',
        data:         String(row[0] || '').trim(), // coluna A
        voo:          vooChegada,
        aeroporto:    String(row[2] || '').trim(), // coluna C
        horarioBase:  sta,
        tipoSolo,
      });
    }

    // Saída
    const vooSaida = String(row[23] || '').trim(); // coluna X
    if (!canceladoSaida && vooSaida && !isCargueira(vooSaida)) {
      resultado.push({
        tipoOperacao: 'SAIDA',
        data:         String(row[22] || '').trim(), // coluna W
        voo:          vooSaida,
        aeroporto:    String(row[24] || '').trim(), // coluna Y
        horarioBase:  std,
        tipoSolo,
      });
    }
  }

  return resultado;
}

// ─── MONITOR (chegada + saídas em 1 batchGet) ───────────────────────────────
// chegada: A(0)=DATA  B(1)=VOO  D(3)=ORI  F(5)=fallback  G(6)=ETA  M(12)=CODE
// saídas:  A(0)=DATA  C(2)=fallback  D(3)=ETD  J(9)=DES  K(10)=VOO  L(11)=CODE
async function getMonitorWide() {
  const sheets = getSheets();
  const response = await sheets.spreadsheets.values.batchGet(
    { spreadsheetId: MONITOR_SHEET_ID, ranges: ['monitor_chegada!A:M', 'monitor_saidas!A:L'] },
    { timeout: 10000 }
  );

  const [chegadaRange, saidasRange] = response.data.valueRanges;

  const rowsCheg = chegadaRange?.values;
  const chegada = (!rowsCheg || rowsCheg.length < 2) ? [] :
    rowsCheg.slice(1).map(row => {
      const eta = extrairHorario(row[6]) || extrairHorario(row[5]); // G, fallback F
      const { code: codeVoo, numero } = normalizarVoo(row[1]);      // col B
      const codeCol = String(row[12] || '').trim().toUpperCase();   // col M
      return {
        data:      String(row[0] || '').trim(),
        code:      codeCol || codeVoo,
        numero,
        aeroporto: String(row[3] || '').trim(), // col D
        eta,
      };
    }).filter(r => r.numero);

  const rowsSaid = saidasRange?.values;
  const saidas = (!rowsSaid || rowsSaid.length < 2) ? [] :
    rowsSaid.slice(1).map(row => {
      const etd = extrairHorarioETD(row[3]) || extrairHorarioETD(row[2]); // D, fallback C
      const { code: codeVoo, numero } = normalizarVoo(row[10]);     // col K
      const codeCol = String(row[11] || '').trim().toUpperCase();   // col L
      return {
        data:      String(row[0] || '').trim(),
        code:      codeCol || codeVoo,
        numero,
        aeroporto: String(row[9] || '').trim(), // col J
        etd,
      };
    }).filter(r => r.numero);

  return { chegada, saidas };
}

// Tenta LA depois JJ, valida aeroporto para evitar match errado
function buscarMonitorLatam(monitorMap, isoData, numero, tipo, aeroportoProg) {
  const aeroporto = String(aeroportoProg || '').trim().toUpperCase();
  for (const latamCode of ['LA', 'JJ']) {
    const candidato = monitorMap.get(`${isoData}_${latamCode}_${numero}_${tipo}`);
    if (!candidato) continue;
    const aeroportoMon = String(candidato.aeroporto || '').trim().toUpperCase();
    if (aeroportoMon === aeroporto) return candidato;
  }
  return undefined;
}

// ─── GETVOOS ─────────────────────────────────────────────────────────────────
async function getVoos() {
  // Retorna do cache se ainda válido (evita reads redundantes em burst)
  const now = Date.now();
  if (_voosCache && now < _voosCacheExpiry) {
    return _voosCache;
  }

  const [progResult, monitorResult, loaderResult] = await Promise.allSettled([
    getProgWide(),
    getMonitorWide(),
    getLoaderPlanilha(),
  ]);

  if (progResult.status === 'rejected') throw progResult.reason;

  const progVoos   = progResult.value;
  const monChegada = monitorResult.status === 'fulfilled' ? monitorResult.value.chegada : [];
  const monSaidas  = monitorResult.status === 'fulfilled' ? monitorResult.value.saidas  : [];
  const loaderVoos = loaderResult.status  === 'fulfilled' ? loaderResult.value          : [];

  if (monitorResult.status === 'rejected') {
    console.warn('[getVoos] Monitor indisponível:', monitorResult.reason?.message);
  }
  if (loaderResult.status === 'rejected') {
    console.warn('[getVoos] Loader indisponível:', loaderResult.reason?.message);
  }


  // Mapa de lookup do Loader: mesma chave dos voos WIDE (isoData_code_numero_tipo)
  const mapLoader = new Map();
  for (const l of loaderVoos) {
    const { code: rawCode, numero } = normalizarVoo(l.voo);
    const code    = rawCode === '' ? 'LA' : rawCode;
    const isoData = normalizarDataISO(l.data);
    if (!isoData || !numero) continue;
    mapLoader.set(`${isoData}_${code}_${numero}_${l.tipoOperacao}`, l);
  }

  // Mapas de lookup: DATA_CODE_NUMERO_TIPO → registro do monitor
  const mapChegada = new Map();
  for (const m of monChegada) {
    const isoData = normalizarDataISO(m.data);
    if (!isoData || !m.code || !m.numero) continue;
    mapChegada.set(`${isoData}_${m.code}_${m.numero}_CHEGADA`, m);
  }

  const mapSaidas = new Map();
  for (const m of monSaidas) {
    const isoData = normalizarDataISO(m.data);
    if (!isoData || !m.code || !m.numero) continue;
    mapSaidas.set(`${isoData}_${m.code}_${m.numero}_SAIDA`, m);
  }

  const voos = progVoos
    .filter(v => isHojeFlexivel(v.data))
    .map(v => {
      const { code: rawCode, numero } = normalizarVoo(v.voo);
      const isLatamNumerico = rawCode === ''; // voo só com dígitos na PROG WIDE → LATAM
      const code    = isLatamNumerico ? 'LA' : rawCode;
      const isoData = normalizarDataISO(v.data);
      const id      = `${isoData}_${code}_${numero}_${v.tipoOperacao}`;

      const monitorMap = v.tipoOperacao === 'CHEGADA' ? mapChegada : mapSaidas;
      const monitor = isLatamNumerico
        ? buscarMonitorLatam(monitorMap, isoData, numero, v.tipoOperacao, v.aeroporto)
        : monitorMap.get(id);

      let horario   = v.horarioBase;
      let aeroporto = v.aeroporto;

      if (monitor) {
        const horarioMonitor = v.tipoOperacao === 'CHEGADA' ? monitor.eta : monitor.etd;
        if (horarioMonitor) horario = horarioMonitor;
        if (monitor.aeroporto) aeroporto = monitor.aeroporto;
      }

      const loaderRecord = mapLoader.get(id);
      const loaderStatus = loaderRecord ? calcLoaderAndon(loaderRecord) : 'CINZA';

      if (loaderRecord) {
        console.log('MATCH LOADER', {
          vooMalha:   v.voo,
          vooLoader:  loaderRecord.voo,
          tipoMalha:  v.tipoOperacao,
          tipoLoader: loaderRecord.tipoOperacao,
          dataMalha:  isoData,
          dataLoader: normalizarDataISO(loaderRecord.data),
        });
      }
      console.log('STATUS LOADER', { voo: v.voo, status: loaderStatus });

      return {
        id,
        tipoOperacao: v.tipoOperacao,
        voo:          v.voo,
        code,
        numeroVoo:    numero,
        aeroporto,
        horario,
        tempo:        minutosAteHorario(horario) ?? 0,
        tipoSolo:     v.tipoSolo || null,
        servicos: {
          loader: { status: loaderStatus },
        },
      };
    })
    .filter(v => isHorarioValido(v.horario))
    .filter(v => estaNaJanelaOperacional(v.horario))
    .filter(v => {
      const mins = minutosAteHorario(v.horario);
      if (mins === null) return false;
      if (mins > 0) return true;                          // futuro: sempre mantém
      if (v.servicos.loader.status === 'VERDE') return false; // VERDE: sai ao virar passado
      return mins > -60;                                  // demais: saída padrão -60 min
    })
    .sort((a, b) =>
      (minutosAteHorario(a.horario) ?? 9999) - (minutosAteHorario(b.horario) ?? 9999)
    )
    .slice(0, 12);

  const nCheg = voos.filter(v => v.tipoOperacao === 'CHEGADA').length;
  const nSaid = voos.filter(v => v.tipoOperacao === 'SAIDA').length;
  console.log(`[getVoos] WIDE: ${voos.length} voos (${nCheg} chegadas, ${nSaid} saídas)`);

  _voosCache      = voos;
  _voosCacheExpiry = Date.now() + CACHE_TTL_MS;

  return voos;
}

module.exports = { getVoos };
