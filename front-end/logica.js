const API_URL = `${API_BASE_URL}/voos`;
const SERVICES = ['loader', 'pushback', 'limpeza', 'qtu', 'qta'];
const LOTE_SIZE = 15;
const ROTATION_MS = 60 * 60 * 1000; // 1 hora
const JANELA_MINUTOS = 60;

const SVC_LABEL = {
  loader:      'LOADER',
  pushback:    'PUSHBACK',
  limpeza:     'LIMPEZA',
  qtu:         'QTU',
  qta:         'QTA',
};

const STATUS = {
  NAO:               { label: 'NÃO ESC.',  cls: 'chip-nao'               },
  ESC:               { label: 'ESCALADO',  cls: 'chip-esc'               },
  CINZA:             { label: 'PADRÃO',    cls: 'chip-cinza'             },
  AZUL:              { label: 'ESCALADO',  cls: 'chip-azul'              },
  AMARELO:           { label: 'ATENÇÃO',   cls: 'chip-amarelo'           },
  AMARELO_PISCANDO:  { label: 'ATENÇÃO!',  cls: 'chip-amarelo-piscando'  },
  VERMELHO:          { label: 'CRÍTICO',   cls: 'chip-vermelho'          },
  VERDE:             { label: 'OK',        cls: 'chip-verde'             },
};

function minutesTo(date) {
  return Math.round((date - Date.now()) / 60000);
}

function fmtTime(d) {
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function fmtTempo(mins) {
  if (mins <= 0) return `-${Math.abs(mins)}min`;
  if (mins < 60) return `${mins}min`;

  const h = Math.floor(mins / 60);
  const m = mins % 60;

  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

function tempoClass(mins) {
  if (mins <= 0) return 't-atrasado';
  if (mins <= 15) return 't-urgente';
  if (mins <= 30) return 't-alerta';
  return 't-normal';
}

function limpezaStatus(f) {
  if (f.limpeza?.escalado) return STATUS.AZUL;
  const mins = minutesTo(f.t);
  if (mins > 5) return STATUS.CINZA;
  if (mins > 0) return STATUS.AMARELO;
  return STATUS.VERMELHO;
}

function statusServicoVisual(f, svc) {
  const servico = f[svc];

  if (servico?.escalado) return STATUS.AZUL;

  const mins = minutesTo(f.t);

  if (mins > 5) return STATUS.CINZA;

  return STATUS.AMARELO;
}

function isPending(f) {
  return Object.values(f.s).some(v => v === 'NAO');
}

function allEscalado(f) {
  return Object.values(f.s).every(v => v === 'ESC');
}

function isHorarioValido(h) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(h || '').trim());
}

function montarDataHojePorHorario(horario) {
  const horarioLimpo = String(horario || '').trim();

  if (!isHorarioValido(horarioLimpo)) return null;

  const [h, m] = horarioLimpo.split(':').map(Number);

  const data = new Date();
  data.setHours(h, m, 0, 0);

  return data;
}

function estaNaJanelaOperacional(dataVoo) {
  const diffMin = minutesTo(dataVoo);

  return diffMin >= -JANELA_MINUTOS && diffMin <= JANELA_MINUTOS;
}

function deveRemoverVoo(f) {
  const mins = minutesTo(f.t);

  return (
    mins <= 0 &&
    f.limpeza?.escalado &&
    f.fonia?.escalado
  );
}

function adaptarVoos(apiVoos) {
  return apiVoos
    .map(v => {
      const horario = String(v.horario || '').trim().slice(0,5);
      const calco = String(v.calco || '').trim();

      const data = montarDataHojePorHorario(horario);

      if (!data) {
  console.warn('VOO IGNORADO POR HORARIO INVALIDO:', v);
  return null;
}

console.log('VOOS RECEBIDOS FRONT:', apiVoos.length);

      return {
        id:           String(v.id || v.voo || '').trim(),
        voo:          String(v.voo || '').trim(),
        route:        String(v.aeroporto || v.origem || '').trim() || '-',
        tipoOperacao: String(v.tipoOperacao || 'CHEGADA').trim(),
        tipoSolo:     v.tipoSolo || null,
        loaderStatus: v.servicos?.loader?.status || 'CINZA',
        t: data,
        calco: v.calco || null,
        fonia:        v.servicos?.fonia        ?? { escalado: false, valor: '' },
        limpeza:      v.servicos?.limpeza      ?? { escalado: false, valor: '' },
        qta:          v.servicos?.qta          ?? { escalado: false, valor: '' },
        qtu:          v.servicos?.qtu          ?? { escalado: false, valor: '' },
        smartfuel:    v.servicos?.smartfuel    ?? { escalado: false, valor: '' },
        'restituiçao': v.servicos?.['restituiçao'] ?? { escalado: false, valor: '' },
        s: {
          pushback:     'ESC',
          limpeza:      'ESC',
          qtu:          'ESC',
          qta:          'ESC',
          fonia:        'ESC',
          smartfuel:    'ESC',
          'restituiçao': 'ESC',
        },
      };
    })
    .filter(Boolean)
    .filter(f => !deveRemoverVoo(f))
    .sort((a, b) => a.t - b.t)
    .slice(0, LOTE_SIZE);
}

let allFlights = [];
let currentLote = [];
let nextRotation = Date.now() + ROTATION_MS;

function foniaStatus(f) {
  if (f.fonia?.escalado) return STATUS.AZUL;

  const mins = minutesTo(f.t);

  if (mins > 30) return STATUS.CINZA;
  if (mins > 5) return STATUS.AMARELO;
  return STATUS.VERMELHO;
}

function buildLote() {
  return [...allFlights]
    .sort((a, b) => a.t - b.t)
    .slice(0, LOTE_SIZE)
    .map(f => f.id);
}

function rotateLote() {
  const exibidos = new Set(currentLote);

  const pendentes = currentLote.filter(id => {
    const f = allFlights.find(x => x.id === id);
    return f && !allEscalado(f);
  });

  const proximos = allFlights
    .filter(f => !exibidos.has(f.id))
    .sort((a, b) => a.t - b.t)
    .map(f => f.id);

  currentLote = [...pendentes, ...proximos].slice(0, LOTE_SIZE);
  nextRotation = Date.now() + ROTATION_MS;
}

function getSortedLote() {
  return currentLote
    .map(id => allFlights.find(f => f.id === id))
    .filter(Boolean)
    .filter(f => !deveRemoverVoo(f))
    .sort((a, b) => a.t - b.t)
    .slice(0, LOTE_SIZE);
}

function render() {
  const flights = getSortedLote();
  const pending = flights.filter(isPending).length;

  document.getElementById('cnt-total').textContent = flights.length;

  const colPending = {};
  flights.forEach(f => {
    colPending[f.id] = isPending(f);
  });

  const table = document.getElementById('painel');
  const rows = [];

  const thVoos = flights.map(f => {
    const cls = colPending[f.id] ? 'col-voo has-pending' : 'col-voo';
    return `<th class="${cls}">${f.voo}</th>`;
  }).join('');

  rows.push(`<tr><th class="row-label">VOO</th>${thVoos}</tr>`);

  const tdTipo = flights.map(f => {
    const isChegada = f.tipoOperacao === 'CHEGADA';
    const cls = isChegada ? 'cell-tipo-chegada' : 'cell-tipo-saida';
    const texto = isChegada ? '↓ CHEGADA' : '↑ SAÍDA';
    return `<td class="cell-info cell-tipo ${cls}">${texto}</td>`;
  }).join('');

  rows.push(`<tr><td class="row-label">TIPO</td>${tdTipo}</tr>`);

  const tdSolo = flights.map(f => {
    const cls = f.tipoSolo === 'TRÂNSITO' ? 'cell-info cell-solo cell-solo-transito' : 'cell-info cell-solo';
    return `<td class="${cls}">${f.tipoSolo || '-'}</td>`;
  }).join('');

  rows.push(`<tr><td class="row-label">SOLO</td>${tdSolo}</tr>`);

  const tdOrigem = flights.map(f =>
    `<td class="cell-info">${f.route}</td>`
  ).join('');

  rows.push(`<tr><td class="row-label">ORIG/DEST</td>${tdOrigem}</tr>`);

  const tdSta = flights.map(f =>
    `<td class="cell-info">${fmtTime(f.t)}</td>`
  ).join('');

  rows.push(`<tr><td class="row-label">ETA/ETD</td>${tdSta}</tr>`);

  const tdTempo = flights.map(f => {
    const mins = minutesTo(f.t);
    const cls = tempoClass(mins);
    return `<td class="cell-info cell-tempo ${cls}">${fmtTempo(mins)}</td>`;
  }).join('');

  rows.push(`<tr><td class="row-label">TEMPO</td>${tdTempo}</tr>`);

  const sepCols = flights.map(() => '<td></td>').join('');
  rows.push(`<tr class="sep-row"><td></td>${sepCols}</tr>`);

  SERVICES.forEach(svc => {
    const tds = flights.map(f => {
      const st = svc === 'loader'
        ? (STATUS[f.loaderStatus] || STATUS.CINZA)
        : STATUS.CINZA;
      const col = colPending[f.id] ? 'cell-svc col-pending' : 'cell-svc';
      return `<td class="${col}"><div class="chip ${st.cls}">${st.label}</div></td>`;
    }).join('');

    rows.push(`<tr><td class="row-label">${SVC_LABEL[svc]}</td>${tds}</tr>`);
  });

  table.innerHTML = rows.join('');
}

const msgs = [
  'WFS · PAINEL WIDE',
  'WIDE BODY · CHEGADA E SAÍDA · AO VIVO',
  '↓ CHEGADA = AZUL · ↑ SAÍDA = VERMELHO · JANELA ±60 MIN',
  'ROTAÇÃO AUTOMÁTICA A CADA 1 HORA',
];

document.getElementById('ticker').innerHTML =
  [...msgs, ...msgs].map(m => `<span>${m}</span>`).join('');

function updateClock() {
  document.getElementById('clock').textContent =
    new Date().toLocaleTimeString('pt-BR');
}

async function fetchFlights() {
  try {
    const res = await fetch(`${API_URL}?t=${Date.now()}`, {
      cache: 'no-store'
    });

    if (!res.ok) {
      throw new Error(`Erro HTTP ${res.status}`);
    }

    const data = await res.json();

    if (!Array.isArray(data)) {
      console.error('Formato inesperado da API:', data);
      allFlights = [];
      currentLote = [];
      render();
      return;
    }

    allFlights = adaptarVoos(data);
    currentLote = buildLote();

    console.log('TOTAL API:', data.length);
    console.log('VOOS FILTRADOS:', allFlights.length);
    console.log('VOOS NA TELA:', currentLote.length);

    render();

  } catch (err) {
    console.error('Erro ao buscar voos:', err);
  }
}

currentLote = [];
nextRotation = Date.now() + ROTATION_MS;

fetchFlights();
updateClock();

setInterval(updateClock, 1000);
setInterval(fetchFlights, 30000);

setInterval(() => {
  if (Date.now() >= nextRotation) rotateLote();
  render();
}, 30000);

// setInterval(() => {
//   console.log('🔄 Auto reload da página (15 min)');
//   location.reload();
// }, 15 * 60 * 1000); // 15 minutos
