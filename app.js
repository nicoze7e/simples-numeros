/* ZIMPLES NUMBREZ · app (PWA)
 * Habla directo con la API de Google Sheets desde el celular, con el permiso drive.file.
 * No hay servidor intermedio. Estructura que asume la planilla:
 *  - REGISTRO: el mes 1 empieza en la fila 19 y cada bloque siguiente 101 filas más abajo (100 renglones por mes).
 *    Columnas: C fecha (fórmula), D moneda, E monto, F tipo, G detalle.
 *  - AJUSTES: B3:B9 monedas.
 *  - Panel de REGISTRO: C2:J2 monedas, C1:J1 saldo por moneda, C12:J12 cotización.
 */
(function () {
  'use strict';
  var VERSION = '1.5 · 2026-11-05';
  var SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var SB = 'https://sheets.googleapis.com/v4/spreadsheets/';
  var BLOQUE = 101, ENTRADAS = 100;
  var MESES = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];
  var COL = ['--usd', '--ars', '--eur', '--c4', '--c5', '--c6', '--c7'];
  /* Perfiles de planilla. La app detecta cuál es por los nombres de las pestañas (ver prep()).
   *  simples  = la plantilla del producto (pestaña REGISTRO + AJUSTES).
   *  personal = la planilla propia del autor (pestaña «AÑO <año>», monedas en su panel). Es una excepción. */
  var PERFILES = {
    simples: { id: 'simples', hoja: 'REGISTRO', primera: 19, monedas: 'AJUSTES!B3:B9', enc: 'C2:J2', saldos: 'C1:J1', tasas: 'C12:J12', panel: [0, 1, 2, 3, 5, 6, 7], fechaManual: false },
    personal: { id: 'personal', hoja: '', primera: 17, monedas: 'C2:F2', enc: 'C2:F2', saldos: 'C1:F1', tasas: 'C10:F10', panel: [0, 1, 2, 3], fechaManual: true }
  };
  var P = PERFILES.simples, perfilDe = '';
  function H(r) { return "'" + P.hoja + "'!" + r; }
  function HM(r) { return (P.monedas.indexOf('!') < 0) ? H(r) : r; }
  var UNF = 'valueRenderOption=UNFORMATTED_VALUE';

  var LS = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } }
  };
  var cfg = (function () {
    var c = window.SN_CONFIG || {};
    if (c.clientId && c.apiKey && c.appId) return c;
    return LS.get('sn_cfg') || {};
  })();

  var tok = null, exp = 0, tc = null, cb = null;
  var D = null, A = null, AN = null, toastT = null;
  var st = { vista: 'cargando', tab: 'anotar', tipo: 'SALIDA', cur: '', txt: '', det: '', dar: '', rec: '', curDar: '', curRec: '', act: 'dar', edit: null, busy: false, error: '', msg: '', movs: [], usadas: 0, mes: '', hoy: '', errA: '' };

  function $(s) { return document.querySelector(s); }
  function el(t, a, h) { var e = document.createElement(t); for (var k in a) e.setAttribute(k, a[k]); if (h != null) e.innerHTML = h; return e; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmt(n, dec) { return n.toLocaleString('es-AR', { minimumFractionDigits: dec || 0, maximumFractionDigits: 2 }); }
  function nf(n) { return fmt(n, n % 1 ? 2 : 0); }
  function enc(s) { return encodeURIComponent(s); }

  /* ---------- Sesión de Google ---------- */
  function cargarTok() { var t = LS.get('sn_tok'); if (t && t.t && Date.now() < t.e) { tok = t.t; exp = t.e; } }
  function vivo() { return !!tok && Date.now() < exp; }
  function gsi() { return window.google && google.accounts && google.accounts.oauth2; }
  function initTc() {
    if (tc || !cfg.clientId || !gsi()) return;
    tc = google.accounts.oauth2.initTokenClient({
      client_id: cfg.clientId, scope: SCOPE,
      callback: function (r) {
        if (r && r.error) { if (cb) { cb.rej(new Error(r.error)); cb = null; } return; }
        tok = r.access_token; exp = Date.now() + (Number(r.expires_in) || 3600) * 1000 - 60000;
        LS.set('sn_tok', { t: tok, e: exp });
        if (!LS.get('sn_hint')) guardarHint();
        if (cb) { cb.res(); cb = null; }
      },
      error_callback: function (e) { if (cb) { cb.rej(new Error((e && e.type) || 'cancelado')); cb = null; } }
    });
  }
  /* Guarda el mail de la cuenta (solo en este celular) para que Google renueve la sesión sin preguntar cuál cuenta. */
  function guardarHint() {
    fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: { Authorization: 'Bearer ' + tok } })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.user && j.user.emailAddress) LS.set('sn_hint', j.user.emailAddress); })
      .catch(function () { /* sin hint: igual funciona */ });
  }
  function esperarGsi(ms) {
    return new Promise(function (res, rej) {
      var t0 = Date.now();
      (function p() { initTc(); if (tc) return res(); if (Date.now() - t0 > ms) return rej(new Error('gsi')); setTimeout(p, 200); })();
    });
  }
  /* Con prompt distinto de 'none' conviene llamarla dentro de un toque del usuario (el navegador abre una ventana). */
  function pedirToken(prompt) {
    return new Promise(function (res, rej) {
      initTc();
      if (!tc) { rej(new Error('gsi')); return; }
      cb = { res: res, rej: rej };
      var o = { prompt: prompt }, h = LS.get('sn_hint'); if (h) o.hint = h;
      tc.requestAccessToken(o);
      setTimeout(function () { if (cb && cb.rej === rej) { cb = null; rej(new Error('tiempo')); } }, prompt === 'none' ? 9000 : 180000);
    });
  }
  function asegurar() {
    if (vivo()) return Promise.resolve();
    return esperarGsi(8000).then(function () { return pedirToken('none'); }).catch(function () {
      var e = new Error('Tu sesión venció.'); e.login = true; throw e;
    });
  }
  /* Renueva el permiso de Google en silencio antes de que venza (dura 1 hora). Si Google no lo permite, avisa con un toque. */
  var renov = false, ultimoFallo = 0;
  function renovarSilencio() {
    if (renov || !cfg.clientId || !fid()) return;
    if (tok && exp - Date.now() > 600000) return;
    if (Date.now() - ultimoFallo < 120000) return;
    renov = true;
    esperarGsi(4000).then(function () { return pedirToken('none'); }).then(function () { ultimoFallo = 0; })
      .catch(function () { ultimoFallo = Date.now(); if (st.vista === 'app' && !vivo()) avisoSesion(); })
      .then(function () { renov = false; });
  }
  function avisoSesion() {
    var h = $('#toastHost'); if (!h) return; h.innerHTML = ''; clearTimeout(toastT);
    var t = el('div', { 'class': 'toast err', role: 'status' }, '<span>Tu sesión se pausó.</span>');
    var b = el('button', { type: 'button' }, 'RENOVAR');
    b.addEventListener('click', function () {
      pedirToken('').then(function () { toastSimple('Sesión renovada.'); })
        .catch(function () { st.vista = 'login'; st.msg = ''; render(); });
    });
    t.appendChild(b); h.appendChild(t);
  }
  setInterval(renovarSilencio, 30000);
  function api(url, opt, reintento) {
    return asegurar().then(function () {
      opt = opt || {};
      opt.headers = Object.assign({ Authorization: 'Bearer ' + tok }, opt.headers || {});
      return fetch(url, opt);
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 && !reintento) { tok = null; exp = 0; LS.set('sn_tok', null); return api(url, opt, true); }
        if (!r.ok) { var e = new Error((j.error && j.error.message) || ('Error ' + r.status)); e.status = r.status; throw e; }
        return j;
      });
    }, function (e) {
      if (e && (e.login || e.status)) throw e;
      throw new Error('Sin conexión. Probá de nuevo.');
    });
  }

  /* ---------- Hoja ---------- */
  function fid() { return LS.get('sn_file') || ''; }
  function U(range, q) { return SB + fid() + '/values/' + enc(range) + (q || ''); }
  function getV(range, extra) { return api(U(range, '?' + UNF + (extra || ''))).then(function (j) { return j.values || []; }); }
  function inicioBloque(k) { return P.primera + BLOQUE * (k - 1); }
  /* Detecta qué planilla es (por sus pestañas) y fija el perfil. Una vez por planilla. */
  function prep() {
    if (perfilDe === fid() && perfilDe) return Promise.resolve();
    return api(SB + fid() + '?fields=sheets.properties.title').then(function (j) {
      var t = (j.sheets || []).map(function (s) { return s.properties.title; });
      var anio = 'AÑO ' + new Date().getFullYear();
      var actual = new Date().getFullYear(), anios = [], m;
      if (t.indexOf('REGISTRO') >= 0) {
        P = PERFILES.simples; P.hoja = 'REGISTRO';
        /* REGISTRO = año en curso · «REGISTRO 2025» = años anteriores archivados */
        t.forEach(function (n) { if ((m = /^REGISTRO (\d{4})$/.exec(n))) anios.push({ hoja: n, anio: +m[1] }); });
        anios.push({ hoja: 'REGISTRO', anio: actual });
      } else if (t.indexOf(anio) >= 0) {
        P = PERFILES.personal; P.hoja = anio;
        t.forEach(function (n) { if ((m = /^AÑO (\d{4})$/.exec(n))) anios.push({ hoja: n, anio: +m[1] }); });
      } else throw new Error('Esta planilla no tiene la pestaña REGISTRO (ni «' + anio + '»). Pestañas que veo: ' + t.join(', '));
      anios.sort(function (a, b) { return a.anio - b.anio; });
      P.anios = anios;
      perfilDe = fid();
    });
  }
  /* Si la columna de fecha de esa fila está vacía (sin fórmula), escribe la fecha de hoy. Solo en planillas con fecha manual. */
  function fechaSiVacia(filas) {
    if (!P.fechaManual) return Promise.resolve();
    var q = filas.map(function (f) { return 'ranges=' + enc(H('C' + f)); }).join('&');
    return api(SB + fid() + '/values:batchGet?' + q + '&valueRenderOption=FORMULA').then(function (j) {
      var data = [];
      (j.valueRanges || []).forEach(function (vr, i) {
        var v = vr.values && vr.values[0] && vr.values[0][0];
        if (v === undefined || v === '') data.push({ range: H('C' + filas[i]), values: [[serial(new Date())]] });
      });
      if (!data.length) return;
      return jsonPost(SB + fid() + '/values:batchUpdate', { valueInputOption: 'RAW', data: data });
    });
  }
  function mesNum() { return new Date().getMonth() + 1; }
  function hoyTxt() { var d = new Date(); return String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0'); }
  function serial(d) { return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 86400000); }
  function redondear(n) { return Math.round(n * 100) / 100; }

  function monedas() {
    return getV(HM(P.monedas)).then(function (v) {
      var out = [];
      if (v.length === 1 && v[0].length > 1) v = v[0].map(function (x) { return [x]; });
      for (var i = 0; i < 7; i++) {
        var n = (v[i] && v[i][0] !== undefined) ? String(v[i][0]).trim() : '';
        if (n) out.push({ nombre: n, c: n.substring(0, 3).toUpperCase(), s: n.substring(3).trim() || '$', slot: i });
      }
      return out;
    });
  }
  function validar(m) {
    var nombres = D ? D.monedas.map(function (x) { return x.nombre; }) : [];
    if (nombres.indexOf(m.moneda) < 0) throw new Error('Esa moneda no está en tu planilla.');
    var monto = Number(m.monto);
    if (!isFinite(monto) || monto <= 0) throw new Error('El monto tiene que ser mayor que cero.');
    var t = String(m.tipo || '').toUpperCase();
    if (t !== 'SALIDA' && t !== 'INGRESO') throw new Error('El tipo es SALIDA o INGRESO.');
    return { moneda: m.moneda, monto: Math.round(monto * 100) / 100, tipoHoja: t === 'SALIDA' ? 'SALIDAS' : 'INGRESOS', detalle: String(m.detalle || '').substring(0, 200) };
  }
  function libres(k, n) {
    var ini = inicioBloque(k);
    return getV(H('E' + ini + ':E' + (ini + ENTRADAS - 1))).then(function (v) {
      var out = [];
      for (var i = 0; i < ENTRADAS && out.length < n; i++) {
        if (!v[i] || v[i][0] === undefined || v[i][0] === '') out.push(ini + i);
      }
      if (out.length < n) throw new Error(n > 1 ? 'No hay lugar para 2 movimientos en el mes. Seguí en el mes siguiente desde la hoja.' : 'El mes está lleno (100 movimientos). Seguí en el mes siguiente desde la hoja.');
      return out;
    });
  }
  function rangoFila(f) { return H('D' + f + ':G' + f); }
  function escribir(f, m) {
    return api(U(rangoFila(f), '?valueInputOption=RAW'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [[m.moneda, m.monto, m.tipoHoja, m.detalle]] }) }).then(function () { return fechaSiVacia([f]); });
  }
  function jsonPost(url, body) { return api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }

  /* Ingresos y salidas por mes (en USD) de una pestaña de año, con la cotización de esa misma pestaña. */
  function resumenAnio(hoja) {
    var R = function (r) { return "'" + hoja + "'!" + r; };
    return Promise.all([
      api(SB + fid() + '/values:batchGet?ranges=' + enc(R(P.enc)) + '&ranges=' + enc(R(P.tasas)) + '&' + UNF).then(function (j) { return j.valueRanges || []; }),
      getV(R('C' + P.primera + ':G' + (P.primera + BLOQUE * 12 - 2)))
    ]).then(function (r) {
      function fila0(i) { return (r[0][i] && r[0][i].values && r[0][i].values[0]) || []; }
      var encab = fila0(0), tasas = fila0(1), tasaDe = {}, ing = [], sal = [], i;
      P.panel.forEach(function (idx) {
        var n = String(encab[idx] || '').trim(), t = Number(tasas[idx]);
        if (n && t > 0) tasaDe[n.substring(0, 3).toUpperCase()] = t;
      });
      for (i = 0; i <= 12; i++) { ing.push(0); sal.push(0); }
      var sinTasa = {};
      for (i = 0; i < r[1].length; i++) {
        if (i % BLOQUE === ENTRADAS) continue;
        var f = r[1][i] || [], monto = f[2];
        if (typeof monto !== 'number') continue;
        if (/cambio/i.test(String(f[4] === undefined ? '' : f[4]))) continue;
        var cod = String(f[1] || '').substring(0, 3).toUpperCase(), tasa = tasaDe[cod];
        if (!tasa) { sinTasa[cod] = true; continue; }
        var mes = Math.floor(i / BLOQUE) + 1;
        if (mes > 12) continue;
        if (String(f[3] || '').indexOf('SALI') === 0) sal[mes] += monto / tasa; else ing[mes] += monto / tasa;
      }
      return { ing: ing, sal: sal, sinTasa: Object.keys(sinTasa) };
    });
  }

  var API = {
    obtenerAnios: function () {
      return Promise.all(P.anios.map(function (a) {
        return resumenAnio(a.hoja).then(function (x) { return { anio: a.anio, hoja: a.hoja, ing: x.ing, sal: x.sal, sinTasa: x.sinTasa }; });
      })).then(function (lista) { return { lista: lista, mesActual: mesNum(), anioActual: new Date().getFullYear() }; });
    },
    obtenerDatos: function () {
      var k = mesNum(), ini = inicioBloque(k);
      return Promise.all([monedas(), getV(H('C' + ini + ':G' + (ini + ENTRADAS - 1)), '&dateTimeRenderOption=FORMATTED_STRING')]).then(function (r) {
        var v = r[1], movs = [], usadas = 0;
        for (var i = 0; i < v.length; i++) {
          var row = v[i] || [], monto = row[2];
          if (typeof monto !== 'number') continue;
          usadas++;
          var sal = String(row[3] || '').indexOf('SALI') === 0;
          movs.push({ fila: ini + i, d: String(row[0] === undefined ? '' : row[0]), cur: String(row[1] || ''), m: sal ? -monto : monto, t: sal ? 'SALIDA' : 'INGRESO', det: String(row[4] === undefined ? '' : row[4]) });
        }
        movs.reverse();
        return { monedas: r[0], mes: MESES[k - 1], hoy: hoyTxt(), filasUsadas: usadas, movimientos: movs.slice(0, 60) };
      });
    },
    registrar: function (mov) {
      var m = validar(mov), k = mesNum();
      return libres(k, 1).then(function (fs) { return escribir(fs[0], m).then(function () { return { fila: fs[0], mes: MESES[k - 1] }; }); });
    },
    registrarCambio: function (c) {
      var sale = validar({ moneda: c.monDar, monto: c.dar, tipo: 'SALIDA', detalle: 'cambio' });
      var entra = validar({ moneda: c.monRec, monto: c.rec, tipo: 'INGRESO', detalle: 'cambio' });
      if (sale.moneda === entra.moneda) throw new Error('Elegí dos monedas distintas.');
      var k = mesNum();
      return libres(k, 2).then(function (fs) {
        return jsonPost(SB + fid() + '/values:batchUpdate', {
          valueInputOption: 'RAW',
          data: [
            { range: rangoFila(fs[0]), values: [[sale.moneda, sale.monto, sale.tipoHoja, sale.detalle]] },
            { range: rangoFila(fs[1]), values: [[entra.moneda, entra.monto, entra.tipoHoja, entra.detalle]] }
          ]
        }).then(function () { return fechaSiVacia(fs); }).then(function () { return { filas: fs }; });
      });
    },
    corregir: function (fila, mov) {
      var m = validar(mov);
      return escribir(fila, m).then(function () { return { fila: fila }; });
    },
    borrar: function (filas, esperado) {
      var q = filas.map(function (f) { return 'ranges=' + enc(H('E' + f)); }).join('&');
      return api(SB + fid() + '/values:batchGet?' + q + '&' + UNF).then(function (j) {
        (j.valueRanges || []).forEach(function (vr, i) {
          var v = vr.values && vr.values[0] && vr.values[0][0];
          if (esperado && esperado[i] !== undefined && Number(v) !== Number(esperado[i])) throw new Error('Ese movimiento cambió en la hoja. No lo borré.');
        });
        return jsonPost(SB + fid() + '/values:batchClear', { ranges: filas.map(rangoFila) });
      }).then(function () { return { borradas: filas.length }; });
    },
    obtenerAnalisis: function () {
      var k = mesNum();
      return Promise.all([
        api(SB + fid() + '/values:batchGet?ranges=' + enc(H(P.enc)) + '&ranges=' + enc(H(P.saldos)) + '&ranges=' + enc(H(P.tasas)) + '&' + UNF).then(function (j) { return j.valueRanges || []; }),
        getV(H('C' + P.primera + ':G' + (P.primera + BLOQUE * 12 - 2)))
      ]).then(function (r) {
        function fila0(i) { return (r[0][i] && r[0][i].values && r[0][i].values[0]) || []; }
        var encab = fila0(0), saldos = fila0(1), tasas = fila0(2), tasaDe = {};
        P.panel.forEach(function (idx) {
          var n = String(encab[idx] || '').trim(), t = Number(tasas[idx]);
          if (n && t > 0) tasaDe[n.substring(0, 3).toUpperCase()] = t;
        });
        var filas = r[1], ing = [], sal = [], dias = {}, sinTasa = {}, i;
        for (i = 0; i <= 12; i++) { ing.push(0); sal.push(0); }
        for (i = 0; i < filas.length; i++) {
          if (i % BLOQUE === ENTRADAS) continue;
          var f = filas[i] || [], monto = f[2];
          if (typeof monto !== 'number') continue;
          if (typeof f[0] === 'number') dias[Math.floor(f[0])] = true;
          if (/cambio/i.test(String(f[4] === undefined ? '' : f[4]))) continue;
          var cod = String(f[1] || '').substring(0, 3).toUpperCase(), tasa = tasaDe[cod];
          if (!tasa) { sinTasa[cod] = true; continue; }
          var mes = Math.floor(i / BLOQUE) + 1, usd = monto / tasa;
          if (String(f[3] || '').indexOf('SALI') === 0) sal[mes] += usd; else ing[mes] += usd;
        }
        var meses = [];
        for (var m = Math.max(1, k - 5); m <= k; m++) meses.push({ m: MESES[m - 1].substring(0, 3), i: redondear(ing[m]), o: redondear(sal[m]) });
        var hoy = new Date(), dia = hoy.getDate();
        var previos = meses.slice(0, -1).filter(function (x) { return x.o > 0; });
        var promPrevio = previos.length ? previos.reduce(function (a, x) { return a + x.o; }, 0) / previos.length / 30 : null;
        var promDia = sal[k] / dia, actual = meses[meses.length - 1];
        var pesos = [];
        P.panel.forEach(function (idx) {
          var n = String(encab[idx] || '').trim(), cod = n.substring(0, 3).toUpperCase(), s = Number(saldos[idx]);
          if (n && s > 0 && tasaDe[cod]) pesos.push({ nombre: n, c: cod, usd: redondear(s / tasaDe[cod]) });
        });
        var hs = serial(hoy), n = 0, desde = dias[hs] ? 0 : 1;
        for (i = desde; i < 400; i++) { if (dias[hs - i]) n++; else break; }
        return { meses: meses, tasa: actual.i > 0 ? (actual.i - actual.o) / actual.i : 0, promDia: redondear(promDia), dif: promPrevio ? (promDia / promPrevio - 1) * 100 : null, racha: n, pesos: pesos, sinTasa: Object.keys(sinTasa) };
      });
    }
  };
  /* Cada llamada espera primero a saber qué planilla es (prep) */
  Object.keys(API).forEach(function (k) {
    var orig = API[k];
    API[k] = function () { var a = arguments; return prep().then(function () { return orig.apply(null, a); }); };
  });
  function srv(fn, args, ok, fail) {
    var p;
    try { p = API[fn].apply(null, args); } catch (e) { p = Promise.reject(e); }
    p.then(ok, function (e) { (fail || falla)(e); });
  }
  function falla(e) {
    st.busy = false;
    if (e && e.login) {
      if (st.vista === 'app' && D) { render(); avisoSesion(); return; }
      st.vista = 'login'; st.msg = 'Tu sesión venció. Iniciá sesión de nuevo.'; render(); return;
    }
    render();
    toastSimple((e && e.message) ? e.message : 'No se pudo completar. Probá de nuevo.', true);
  }

  /* ---------- Pantallas ---------- */
  function mon(n) { for (var i = 0; i < D.monedas.length; i++) if (D.monedas[i].nombre === n) return D.monedas[i]; return { nombre: n, c: String(n).substring(0, 3), s: '$', slot: 0 }; }
  function colV(n) { return COL[mon(n).slot] || '--ink'; }
  function parse(t) { if (!t) return 0; return parseFloat(String(t).replace(',', '.')) || 0; }
  function pad(key) {
    var f = st.tab === 'anotar' ? 'txt' : st.act, v = st[f];
    if (key === 'back') { v = v.slice(0, -1); }
    else if (key === ',') { if (v.indexOf(',') < 0) v = (v || '0') + ','; }
    else { var p = v.split(','); if (p[1] !== undefined && p[1].length >= 2) return; if (p[0].length >= 9) return; if (v === '0') v = key; else v += key; }
    st[f] = v; render();
  }
  function tecla(k, l) { return '<button type="button" data-k="' + k + '" aria-label="' + (l || k) + '">' + (l || k) + '</button>'; }
  function keypad() { return '<div class="pad">' + ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(function (k) { return tecla(k); }).join('') + tecla(',', ',') + tecla('0') + tecla('back', '⌫') + '</div>'; }
  function chips(sel, attr) { return '<div class="cur">' + D.monedas.map(function (m) { return '<button type="button" class="chip" ' + attr + '="' + esc(m.nombre) + '" aria-pressed="' + (sel === m.nombre) + '"><i style="background:var(' + COL[m.slot] + ')"></i>' + esc(m.c + ' ' + m.s) + '</button>'; }).join('') + '</div>'; }

  function vAnotar() {
    var n = parse(st.txt), m = mon(st.cur), lleno = st.usadas >= 100;
    return '<div class="seg" role="group" aria-label="Tipo de movimiento">' +
      '<button type="button" class="out" data-tipo="SALIDA" aria-pressed="' + (st.tipo === 'SALIDA') + '">SALIDA</button>' +
      '<button type="button" class="in" data-tipo="INGRESO" aria-pressed="' + (st.tipo === 'INGRESO') + '">INGRESO</button></div>' +
      chips(st.cur, 'data-cur') +
      '<div class="amount"><span class="code">' + esc(m.c + ' ' + m.s) + '</span><span class="num' + (st.txt ? '' : ' empty') + '">' + (st.txt || '0') + '</span></div>' +
      keypad() +
      '<input class="det" id="det" type="text" maxlength="200" placeholder="Contá qué pasó (opcional)" value="' + esc(st.det) + '" autocomplete="off">' +
      '<button type="button" id="save" class="save ' + (st.tipo === 'SALIDA' ? 'out' : 'in') + '"' + ((n > 0 && !st.busy && !lleno) ? '' : ' disabled') + '>' + (st.busy ? 'GUARDANDO…' : 'GUARDAR ' + st.tipo) + '</button>' +
      '<div class="where">' + (lleno ? 'El mes está lleno: seguí en el mes siguiente desde la hoja' : 'Se anota en ' + st.mes + ' · renglón ' + (st.usadas + 1) + ' de 100') + '</div>';
  }
  function vCambio() {
    var n1 = parse(st.dar), n2 = parse(st.rec);
    function box(f, tit, cur, attr) { var m = mon(cur); return '<div class="box" data-box="' + f + '" data-on="' + (st.act === f ? 1 : 0) + '"><h3>' + tit + '</h3>' + chips(cur, attr) + '<div class="row"><span class="hint">' + esc(m.c + ' ' + m.s) + '</span><span class="num' + (st[f] ? '' : ' empty') + '">' + (st[f] || '0') + '</span></div></div>'; }
    return '<div class="swap">' + box('dar', 'Entregué', st.curDar, 'data-cd') + '<div class="arrow">↓</div>' + box('rec', 'Recibí', st.curRec, 'data-cr') + '</div>' +
      keypad() +
      '<button type="button" id="saveC" class="save in"' + ((n1 > 0 && n2 > 0 && st.curDar !== st.curRec && !st.busy && st.usadas <= 98) ? '' : ' disabled') + '>' + (st.busy ? 'GUARDANDO…' : 'ANOTAR CAMBIO') + '</button>' +
      '<div class="hint">' + (st.curDar === st.curRec ? 'Elegí dos monedas distintas.' : 'Se anotan 2 movimientos con la palabra «cambio» en el detalle.') + '</div>';
  }
  function vMes() {
    var t = {}; D.monedas.forEach(function (m) { t[m.nombre] = 0; }); st.movs.forEach(function (x) { if (t[x.cur] !== undefined) t[x.cur] += x.m; });
    var h = '<div class="hint">' + st.mes + ' · últimos movimientos</div><div class="tot">' + D.monedas.map(function (m) { return '<div><small style="color:var(' + COL[m.slot] + ')">' + esc(m.c + ' ' + m.s) + '</small><b>' + fmt(t[m.nombre]) + '</b></div>'; }).join('') + '</div>';
    if (!st.movs.length) return h + '<div class="vacio">Todavía no anotaste nada este mes.<br>Tus movimientos van a aparecer acá.</div>';
    h += '<ul class="list">';
    st.movs.forEach(function (x, i) {
      h += '<li data-i="' + i + '" tabindex="0" role="button" aria-label="Corregir movimiento"><span class="d">' + esc(x.d) + '</span><span class="t">' + (x.det ? esc(x.det) : '<span class="hint">sin detalle</span>') + '<small>' + esc(mon(x.cur).c) + ' · ' + x.t.toLowerCase() + '</small></span><span class="m ' + (x.m < 0 ? 'o' : 'i') + '">' + (x.m < 0 ? '−' : '+') + fmt(Math.abs(x.m), Math.abs(x.m) % 1 ? 2 : 0) + '</span></li>';
    });
    return h + '</ul><div class="hint">Tocá un movimiento para corregirlo. La fecha se cambia directamente en la hoja.</div>';
  }
  function usdF(n) { return '$' + fmt(Math.round(n)); }
  function chartIO(data) {
    var W = 340, H = 190, L = 40, B = 24, T = 14, R = 6, iw = W - L - R, ih = H - T - B;
    var mx = 0; data.forEach(function (d) { mx = Math.max(mx, d.i, d.o); }); mx = Math.max(500, Math.ceil(mx / 500) * 500);
    var Y = function (v) { return T + ih - (v / mx) * ih; }, g = '', bw = Math.min(14, iw / data.length / 2.6);
    [0, mx / 2, mx].forEach(function (v) { g += '<line class="gl" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(v) + '" y2="' + Y(v) + '"/><text x="' + (L - 6) + '" y="' + (Y(v) + 3) + '" text-anchor="end">' + fmt(v) + '</text>'; });
    data.forEach(function (d, k) {
      var cx = L + iw * (k + .5) / data.length, cur = k === data.length - 1;
      g += '<rect x="' + (cx - bw - 1) + '" y="' + Y(d.i) + '" width="' + bw + '" height="' + (Y(0) - Y(d.i)) + '" rx="2" style="fill:var(--ok)"/>';
      g += '<rect x="' + (cx + 1) + '" y="' + Y(d.o) + '" width="' + bw + '" height="' + (Y(0) - Y(d.o)) + '" rx="2" style="fill:var(--out-bg)"/>';
      g += '<text x="' + cx + '" y="' + (H - 8) + '" text-anchor="middle"' + (cur ? ' class="lb"' : '') + '>' + d.m + (cur ? ' ·hoy' : '') + '</text>';
    });
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Ingresos y salidas de los últimos meses">' + g + '</svg>';
  }
  function chartRate(data) {
    var W = 340, H = 140, L = 8, B = 22, T = 20, R = 8, iw = W - L - R, ih = H - T - B, g = '', bw = Math.min(30, iw / data.length * .55);
    var rs = data.map(function (d) { return d.i > 0 ? Math.max(0, (d.i - d.o) / d.i) : 0; }), mx = Math.max(.3, Math.max.apply(null, rs));
    g += '<line class="gl" x1="' + L + '" x2="' + (W - R) + '" y1="' + (T + ih) + '" y2="' + (T + ih) + '"/>';
    data.forEach(function (d, k) {
      var cx = L + iw * (k + .5) / data.length, h = ih * rs[k] / mx, cur = k === data.length - 1;
      g += '<rect x="' + (cx - bw / 2) + '" y="' + (T + ih - h) + '" width="' + bw + '" height="' + h + '" rx="3" style="fill:' + (cur ? 'var(--ink)' : 'var(--ok)') + '"/>';
      g += '<text x="' + cx + '" y="' + (T + ih - h - 5) + '" text-anchor="middle" class="lb">' + Math.round(rs[k] * 100) + '%</text>';
      g += '<text x="' + cx + '" y="' + (H - 6) + '" text-anchor="middle"' + (cur ? ' class="lb"' : '') + '>' + d.m + '</text>';
    });
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Tasa de ahorro por mes">' + g + '</svg>';
  }
  function sumaMeses(a, hasta) { var s = 0; for (var m = 1; m <= hasta; m++) s += a[m]; return s; }
  function pct(nuevo, viejo) { return viejo > 0 ? Math.round((nuevo / viejo - 1) * 100) : null; }
  function seccionAnios() {
    var t = '<div class="sec"><h2>Año contra año</h2>';
    if (st.errN) return t + '<p>No pude leer los otros años.<br>' + esc(st.errN) + '</p></div>';
    if (!AN) return t + '<p>Calculando…</p></div>';
    var L = AN.lista;
    if (L.length < 2) return t + '<p>Cuando tengas dos años en la planilla, los comparo acá. Para el año que viene: duplicá la pestaña de este año y dale el nombre del año nuevo; la vieja queda como historia.</p></div>';
    var data = L.map(function (y) { return { m: String(y.anio), i: redondear(sumaMeses(y.ing, 12)), o: redondear(sumaMeses(y.sal, 12)) }; });
    var ult = L[L.length - 1], ant = L[L.length - 2];
    var hasta = ult.anio === AN.anioActual ? AN.mesActual : 12;
    var gI = sumaMeses(ult.ing, hasta), gO = sumaMeses(ult.sal, hasta), aI = sumaMeses(ant.ing, hasta), aO = sumaMeses(ant.sal, hasta);
    var h = t + '<p>Totales de cada año, en dólares.</p>' + chartIO(data) + '<div class="leg"><span><i style="background:var(--ok)"></i>ingresos</span><span><i style="background:var(--out-bg)"></i>salidas</span></div>';
    var pO = pct(gO, aO), pI = pct(gI, aI);
    var periodo = hasta === 12 ? 'el año completo' : 'enero a ' + MESES[hasta - 1].toLowerCase();
    var txt = '';
    if (pO !== null) txt += 'En ' + periodo + ', ' + ult.anio + ' tuvo ' + Math.abs(pO) + '% ' + (pO <= 0 ? 'menos' : 'más') + ' de salidas que ' + ant.anio + '.';
    if (pI !== null) txt += ' Los ingresos fueron ' + Math.abs(pI) + '% ' + (pI <= 0 ? 'menores' : 'mayores') + '.';
    if (txt) h += '<div class="insight">' + txt + ' (mismo período en los dos años).</div>';
    h += '<div class="hint">Cada año se convierte a dólares con la cotización de su propia pestaña.</div>';
    return h + '</div>';
  }
  function vAnalisis() {
    if (st.errA) return '<div class="vacio">No pude calcular el análisis.<br>' + esc(st.errA) + '<br><button type="button" class="ghost" id="reA">REINTENTAR</button></div>';
    if (!A) return '<div class="vacio">Calculando tu análisis…</div>';
    var h = '<div class="hint">No cuenta los cambios de moneda. Todo en dólares, con la cotización de la hoja.</div>';
    if (!A.meses.length || A.meses.every(function (m) { return m.i === 0 && m.o === 0; })) return h + '<div class="vacio">Todavía no hay movimientos para analizar.<br>Anotá algunos y volvé.</div>';
    h += '<div class="cards"><div><small>Tasa de ahorro del mes</small><b class="' + (A.tasa > 0 ? 'pos' : '') + '">' + Math.round(A.tasa * 100) + '%</b></div>' +
      '<div><small>Gasto promedio por día</small><b>' + usdF(A.promDia) + '</b></div>' +
      '<div><small>Días seguidos anotando</small><b>' + A.racha + '</b></div></div>';
    if (A.dif !== null) h += '<div class="insight">Por día gastás un ' + Math.abs(Math.round(A.dif)) + '% ' + (A.dif <= 0 ? 'menos' : 'más') + ' que tu promedio de los meses anteriores.</div>';
    h += '<div class="sec"><h2>Ingresos y salidas</h2><p>En dólares, mes a mes.</p>' + chartIO(A.meses) + '<div class="leg"><span><i style="background:var(--ok)"></i>ingresos</span><span><i style="background:var(--out-bg)"></i>salidas</span></div></div>';
    h += '<div class="sec"><h2>Cuánto te quedó de lo que entró</h2><p>Tasa de ahorro por mes.</p>' + chartRate(A.meses) + '</div>';
    if (A.pesos.length) {
      var tot = A.pesos.reduce(function (a, p) { return a + p.usd; }, 0);
      h += '<div class="sec"><h2>Dónde está tu plata</h2><p>Peso de cada moneda, en dólares.</p><div class="stack">' + A.pesos.map(function (p) { return '<i style="width:' + (p.usd / tot * 100) + '%;background:var(' + colV(p.nombre) + ')"></i>'; }).join('') + '</div><div class="leg">' + A.pesos.map(function (p) { return '<span><i style="background:var(' + colV(p.nombre) + ')"></i>' + esc(p.c) + ' ' + Math.round(p.usd / tot * 100) + '% · ' + usdF(p.usd) + '</span>'; }).join('') + '</div></div>';
    }
    if (A.sinTasa && A.sinTasa.length) h += '<div class="hint">Falta la cotización de ' + esc(A.sinTasa.join(', ')) + ': esos movimientos no entran en el análisis. Revisá la hoja REGISTRO.</div>';
    return h + seccionAnios() + '<div class="hint">Más filtros y gráficos: abrí la hoja.</div>';
  }
  function vEditar() {
    var e = st.edit;
    return '<div class="ed"><h2>Corregir movimiento</h2>' +
      '<div class="seg" role="group"><button type="button" class="out" data-etipo="SALIDA" aria-pressed="' + (e.tipo === 'SALIDA') + '">SALIDA</button><button type="button" class="in" data-etipo="INGRESO" aria-pressed="' + (e.tipo === 'INGRESO') + '">INGRESO</button></div>' +
      chips(e.cur, 'data-ecur') +
      '<input class="num-in" id="emonto" type="text" inputmode="decimal" value="' + esc(e.monto) + '" aria-label="Monto">' +
      '<input class="det" id="edet" type="text" maxlength="200" placeholder="Detalle (opcional)" value="' + esc(e.det) + '" autocomplete="off">' +
      '<div class="hint">Fecha: ' + esc(e.d) + '. Para cambiarla, editá la hoja.</div>' +
      '<button type="button" id="esave" class="save ' + (e.tipo === 'SALIDA' ? 'out' : 'in') + '"' + (st.busy ? ' disabled' : '') + '>' + (st.busy ? 'GUARDANDO…' : 'GUARDAR CAMBIOS') + '</button>' +
      '<div class="acts"><button type="button" id="ecancel" class="ghost">CANCELAR</button><button type="button" id="edel" class="ghost del"' + (st.busy ? ' disabled' : '') + '>BORRAR</button></div></div>';
  }
  function vConfig() {
    return '<div class="ed"><h2>Configuración inicial</h2><p class="hint">Esta app todavía no tiene los datos de Google. Pegalos una sola vez.</p>' +
      '<label class="lab" for="ccid">ID de cliente</label><input class="det" id="ccid" autocomplete="off">' +
      '<label class="lab" for="ckey">Clave de API</label><input class="det" id="ckey" autocomplete="off">' +
      '<label class="lab" for="capp">Número de proyecto</label><input class="det" id="capp" inputmode="numeric" autocomplete="off">' +
      '<button type="button" id="bcfg" class="save in">GUARDAR</button></div>';
  }
  function vLogin() {
    return '<div class="bienvenida"><h2>Tus números son tuyos</h2><p>Iniciá sesión con Google para anotar en tu propia planilla. La app solo toca el archivo que elijas.</p>' +
      (st.msg ? '<p class="aviso">' + esc(st.msg) + '</p>' : '') +
      '<button type="button" id="btnLogin" class="save in">INICIAR SESIÓN CON GOOGLE</button>' +
      '<p class="hint">Google te va a pedir permiso para ver, editar, crear y borrar solo los archivos específicos de Drive que uses con esta app.</p></div>';
  }
  function vPlanilla() {
    return '<div class="bienvenida"><h2>Elegí tu planilla</h2><p>Buscá tu planilla en tu Drive y tocá «Seleccionar».</p>' +
      (st.msg ? '<p class="aviso">' + esc(st.msg) + '</p>' : '') +
      '<button type="button" id="btnPick" class="save in">ELEGIR MI PLANILLA</button></div>';
  }
  function vAjustes() {
    var id = fid();
    return '<div class="ed"><h2>Ajustes</h2>' +
      (id ? '<a class="ghost lnk" href="https://docs.google.com/spreadsheets/d/' + esc(id) + '/edit" target="_blank" rel="noopener">ABRIR MI PLANILLA</a>' : '') +
      '<button type="button" id="aCambiar" class="ghost">CAMBIAR DE PLANILLA</button>' +
      '<button type="button" id="aSalir" class="ghost">CERRAR SESIÓN EN ESTE CELULAR</button>' +
      '<p class="hint">Para quitarle el acceso a la app desde Google: myaccount.google.com/permissions</p>' +
      '<button type="button" id="aVolver" class="save in">VOLVER</button>' +
      '<p class="hint">Versión ' + VERSION + '</p></div>';
  }

  function render() {
    var s = $('#screen'), app = $('#app');
    var enApp = st.vista === 'app';
    app.classList.toggle('sinTabs', !enApp);
    $('#gear').hidden = !(enApp || st.vista === 'ajustes');
    if (st.vista === 'cargando') { s.innerHTML = '<div class="vacio">Cargando…</div>'; $('#mesTop').textContent = ''; return; }
    if (st.vista === 'error') { s.innerHTML = '<div class="vacio">No pude leer tu planilla.<br>' + esc(st.error) + '<br><button type="button" class="ghost" id="reload">REINTENTAR</button></div>'; bind(); return; }
    if (st.vista === 'config') s.innerHTML = vConfig();
    else if (st.vista === 'login') s.innerHTML = vLogin();
    else if (st.vista === 'planilla') s.innerHTML = vPlanilla();
    else if (st.vista === 'ajustes') s.innerHTML = vAjustes();
    else if (!D.monedas.length) s.innerHTML = '<div class="vacio">Todavía no hay monedas.<br>Escribí una en la hoja AJUSTES y volvé.</div>';
    else s.innerHTML = st.edit ? vEditar() : st.tab === 'anotar' ? vAnotar() : st.tab === 'cambio' ? vCambio() : st.tab === 'analisis' ? vAnalisis() : vMes();
    if (enApp) {
      $('#mesTop').textContent = st.mes + ' · ' + st.hoy;
      document.querySelectorAll('.tabs button').forEach(function (b) { b.setAttribute('aria-selected', b.dataset.tab === st.tab); });
    } else { $('#mesTop').textContent = ''; }
    bind();
  }
  function toast(msg, fn) {
    var h = $('#toastHost'); h.innerHTML = ''; clearTimeout(toastT);
    var t = el('div', { 'class': 'toast', role: 'status' }, '<span>' + esc(msg) + '</span>');
    var b = el('button', { type: 'button' }, 'DESHACER'); b.addEventListener('click', function () { h.innerHTML = ''; fn(); });
    t.appendChild(b); h.appendChild(t);
    toastT = setTimeout(function () { h.innerHTML = ''; }, 7000);
  }
  function toastSimple(msg, err) {
    var h = $('#toastHost'); h.innerHTML = ''; clearTimeout(toastT);
    h.appendChild(el('div', { 'class': 'toast' + (err ? ' err' : ''), role: 'status' }, '<span>' + esc(msg) + '</span>'));
    toastT = setTimeout(function () { h.innerHTML = ''; }, err ? 7000 : 4500);
  }
  window.addEventListener('offline', function () { toastSimple('Sin conexión: lo que anotes no se va a guardar hasta que vuelva.', true); });
  window.addEventListener('online', function () { toastSimple('Volvió la conexión.'); });
  function fmtIn(n) { return String(n).replace('.', ','); }
  function keepEd() { var m = $('#emonto'), t = $('#edet'); if (m) st.edit.monto = m.value; if (t) st.edit.det = t.value; }

  /* ---------- Acciones ---------- */
  function guardar() {
    var n = parse(st.txt); if (n <= 0 || st.busy || st.usadas >= 100) return;
    var mov = { moneda: st.cur, monto: n, tipo: st.tipo, detalle: st.det.trim() };
    st.busy = true; render();
    srv('registrar', [mov], function (r) {
      st.busy = false; st.usadas++;
      st.movs.unshift({ fila: r.fila, d: st.hoy, cur: mov.moneda, m: mov.tipo === 'SALIDA' ? -n : n, t: mov.tipo, det: mov.detalle });
      var antes = { txt: st.txt, det: st.det }; st.txt = ''; st.det = ''; render();
      toast('Anotado en ' + st.mes + ' · ' + mon(mov.moneda).c + ' ' + nf(n), function () {
        srv('borrar', [[r.fila], [n]], function () {
          st.movs = st.movs.filter(function (x) { return x.fila !== r.fila; }); st.usadas--; st.txt = antes.txt; st.det = antes.det; render();
        });
      });
    });
  }
  function guardarCambio() {
    var a = parse(st.dar), r = parse(st.rec); if (a <= 0 || r <= 0 || st.curDar === st.curRec || st.busy) return;
    st.busy = true; render();
    srv('registrarCambio', [{ dar: a, monDar: st.curDar, rec: r, monRec: st.curRec }], function (res) {
      st.busy = false; st.usadas += 2;
      st.movs.unshift({ fila: res.filas[0], d: st.hoy, cur: st.curDar, m: -a, t: 'SALIDA', det: 'cambio' });
      st.movs.unshift({ fila: res.filas[1], d: st.hoy, cur: st.curRec, m: r, t: 'INGRESO', det: 'cambio' });
      var antes = { dar: st.dar, rec: st.rec }; st.dar = ''; st.rec = ''; st.act = 'dar'; render();
      toast('Cambio anotado: ' + nf(a) + ' ' + mon(st.curDar).c + ' → ' + nf(r) + ' ' + mon(st.curRec).c, function () {
        srv('borrar', [res.filas, [a, r]], function () {
          st.movs = st.movs.filter(function (x) { return res.filas.indexOf(x.fila) < 0; }); st.usadas -= 2; st.dar = antes.dar; st.rec = antes.rec; render();
        });
      });
    });
  }
  function corregirMov() {
    keepEd(); var n = parse(st.edit.monto); if (n <= 0 || st.busy) return;
    var e = st.edit, x = st.movs[e.i];
    st.busy = true; render();
    srv('corregir', [x.fila, { moneda: e.cur, monto: n, tipo: e.tipo, detalle: e.det.trim() }], function () {
      st.busy = false; x.t = e.tipo; x.cur = e.cur; x.m = e.tipo === 'SALIDA' ? -n : n; x.det = e.det.trim();
      st.edit = null; render(); toastSimple('Movimiento corregido');
    });
  }
  function borrarMov() {
    var e = st.edit, x = st.movs[e.i]; if (st.busy) return;
    st.busy = true; render();
    srv('borrar', [[x.fila], [Math.abs(x.m)]], function () {
      st.busy = false; st.movs.splice(e.i, 1); st.usadas--; st.edit = null; render();
      toast('Movimiento borrado', function () {
        srv('registrar', [{ moneda: x.cur, monto: Math.abs(x.m), tipo: x.t, detalle: x.det }], function () { refrescar(); });
      });
    });
  }
  function refrescar() {
    srv('obtenerDatos', [], function (d) { D = d; st.movs = d.movimientos; st.usadas = d.filasUsadas; st.mes = d.mes; st.hoy = d.hoy; render(); }, function (e) { if (e && e.login) falla(e); });
  }
  function cargarAnalisis() {
    st.errA = ''; render();
    srv('obtenerAnalisis', [], function (a) { A = a; render(); }, function (e) { if (e && e.login) { falla(e); return; } st.errA = (e && e.message) || ''; render(); });
    st.errN = ''; AN = null;
    srv('obtenerAnios', [], function (a) { AN = a; render(); }, function (e) { if (e && e.login) { falla(e); return; } st.errN = (e && e.message) || 'Error'; render(); });
  }
  function cargar() {
    st.vista = 'cargando'; render();
    API.obtenerDatos().then(function (d) {
      D = d; st.movs = d.movimientos; st.usadas = d.filasUsadas; st.mes = d.mes; st.hoy = d.hoy;
      if (d.monedas.length) {
        var nombres = d.monedas.map(function (m) { return m.nombre; });
        if (nombres.indexOf(st.cur) < 0) st.cur = nombres[0];
        if (nombres.indexOf(st.curDar) < 0) st.curDar = nombres[0];
        if (nombres.indexOf(st.curRec) < 0) st.curRec = nombres[1] || nombres[0];
      }
      st.vista = 'app'; render();
    }).catch(function (e) {
      if (e && e.login) { st.vista = 'login'; st.msg = ''; render(); return; }
      if (e && (e.status === 404 || e.status === 403)) { st.vista = 'planilla'; st.msg = 'No pude abrir esa planilla. Elegila de nuevo.'; render(); return; }
      st.vista = 'error'; st.error = (e && e.message) || 'Error desconocido.'; render();
    });
  }
  function arrancar() {
    cargarTok();
    if (!(cfg.clientId && cfg.apiKey && cfg.appId)) { st.vista = 'config'; render(); return; }
    esperarGsi(15000).catch(function () { /* se reintenta al tocar */ });
    if (!fid()) { st.vista = vivo() ? 'planilla' : 'login'; render(); return; }
    if (!vivo()) {
      st.vista = 'cargando'; render();
      asegurar().then(cargar).catch(function () { st.vista = 'login'; st.msg = ''; render(); });
      return;
    }
    cargar();
  }
  function elegirPlanilla() {
    if (!window.gapi) { toastSimple('El selector de Google todavía no cargó. Probá en unos segundos.'); return; }
    gapi.load('picker', function () {
      var v = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS).setMode(google.picker.DocsViewMode.LIST);
      new google.picker.PickerBuilder().addView(v).setOAuthToken(tok).setDeveloperKey(cfg.apiKey).setAppId(cfg.appId)
        .setCallback(function (d) {
          if (d.action === google.picker.Action.PICKED) { LS.set('sn_file', d.docs[0].id); st.msg = ''; cargar(); }
        }).build().setVisible(true);
    });
  }

  function bind() {
    var q = function (s, fn) { document.querySelectorAll(s).forEach(fn); };
    var on = function (id, fn) { var e = $(id); if (e) e.addEventListener('click', fn); };
    q('[data-k]', function (b) { b.addEventListener('click', function () { pad(b.dataset.k); }); });
    q('[data-tipo]', function (b) { b.addEventListener('click', function () { st.tipo = b.dataset.tipo; render(); }); });
    q('[data-cur]', function (b) { b.addEventListener('click', function () { st.cur = b.dataset.cur; render(); }); });
    q('[data-cd]', function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); st.curDar = b.dataset.cd; st.act = 'dar'; render(); }); });
    q('[data-cr]', function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); st.curRec = b.dataset.cr; st.act = 'rec'; render(); }); });
    q('[data-box]', function (b) { b.addEventListener('click', function () { st.act = b.dataset.box; render(); }); });
    q('.list li[data-i]', function (li) {
      function abrir() { var x = st.movs[+li.dataset.i]; st.edit = { i: +li.dataset.i, tipo: x.t, cur: x.cur, monto: fmtIn(Math.abs(x.m)), det: x.det, d: x.d }; render(); }
      li.addEventListener('click', abrir); li.addEventListener('keydown', function (e) { if (e.key === 'Enter') abrir(); });
    });
    q('[data-etipo]', function (b) { b.addEventListener('click', function () { keepEd(); st.edit.tipo = b.dataset.etipo; render(); }); });
    q('[data-ecur]', function (b) { b.addEventListener('click', function () { keepEd(); st.edit.cur = b.dataset.ecur; render(); }); });
    on('#save', guardar); on('#saveC', guardarCambio); on('#esave', corregirMov); on('#edel', borrarMov);
    on('#ecancel', function () { st.edit = null; render(); });
    on('#reload', cargar); on('#reA', cargarAnalisis);
    on('#btnLogin', function () {
      initTc();
      if (!tc) { toastSimple('Google todavía está cargando. Probá en unos segundos.'); return; }
      pedirToken('').then(arrancar).catch(function (e) { toastSimple('No se pudo iniciar sesión' + (e && e.message && e.message !== 'cancelado' ? ': ' + e.message : '.')); });
    });
    on('#btnPick', elegirPlanilla);
    on('#bcfg', function () {
      var c = { clientId: $('#ccid').value.trim(), apiKey: $('#ckey').value.trim(), appId: $('#capp').value.trim() };
      if (!c.clientId || !c.apiKey || !c.appId) { toastSimple('Faltan datos.'); return; }
      LS.set('sn_cfg', c); cfg = c; arrancar();
    });
    on('#aCambiar', function () { st.msg = ''; st.vista = vivo() ? 'planilla' : 'login'; render(); });
    on('#aSalir', function () { tok = null; exp = 0; LS.set('sn_tok', null); LS.set('sn_hint', null); st.msg = ''; st.vista = 'login'; render(); });
    on('#aVolver', function () { st.vista = 'app'; render(); });
    var d = $('#det'); if (d) d.addEventListener('input', function () { st.det = d.value; });
  }
  $('#gear').addEventListener('click', function () { st.vista = st.vista === 'ajustes' ? 'app' : 'ajustes'; st.edit = null; render(); });
  document.querySelectorAll('.tabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      st.tab = b.dataset.tab; st.edit = null; render();
      if (st.tab === 'mes') refrescar();
      if (st.tab === 'analisis') cargarAnalisis();
    });
  });
  document.addEventListener('keydown', function (e) {
    if (st.vista !== 'app' || !D || (e.target && e.target.tagName === 'INPUT')) return;
    if (st.tab === 'mes' || st.tab === 'analisis' || st.edit) return;
    if (/^[0-9]$/.test(e.key)) { pad(e.key); } else if (e.key === ',' || e.key === '.') { pad(','); } else if (e.key === 'Backspace') { pad('back'); }
    else if (e.key === 'Enter') { var s = $('#save') || $('#saveC'); if (s && !s.disabled) s.click(); }
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    ultimoFallo = 0; renovarSilencio();
    if (st.vista === 'app' && st.tab === 'mes') refrescar();
  });
  /* Deslizar de lado cambia de pestaña (solo con un gesto claramente horizontal y sin teclado abierto). */
  (function () {
    var ORDEN = ['anotar', 'cambio', 'mes', 'analisis'], x0 = 0, y0 = 0, t0 = 0, ok = false;
    var zona = $('#app');
    zona.addEventListener('touchstart', function (e) {
      var t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; t0 = Date.now();
      ok = e.touches.length === 1 && st.vista === 'app' && !st.edit && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
    }, { passive: true });
    zona.addEventListener('touchend', function (e) {
      if (!ok) return; ok = false;
      var t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
      if (Date.now() - t0 > 700 || Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.8) return;
      var i = ORDEN.indexOf(st.tab) + (dx < 0 ? 1 : -1);
      if (i < 0 || i >= ORDEN.length) return;
      var b = document.querySelector('.tabs button[data-tab="' + ORDEN[i] + '"]'); if (b) b.click();
    }, { passive: true });
  })();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () { /* sin service worker */ });
  arrancar();
})();
