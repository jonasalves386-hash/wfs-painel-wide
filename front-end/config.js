const API_BASE_URL = (() => {
  const { hostname } = window.location;

  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return "http://localhost:3007";
  }

  return `${window.location.origin}/api-wide`;
})();