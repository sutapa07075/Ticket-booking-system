/**
 * common.js — shared across every page.
 * Handles: token storage, nav bar rendering, auth guards, authenticated fetch.
 */

const Auth = {
  getUserToken() { return localStorage.getItem('busgo_user_token'); },
  getUser() { try { return JSON.parse(localStorage.getItem('busgo_user') || 'null'); } catch { return null; } },
  setUser(token, user) {
    localStorage.setItem('busgo_user_token', token);
    localStorage.setItem('busgo_user', JSON.stringify(user));
  },
  getOfficialToken() { return localStorage.getItem('busgo_official_token'); },
  getOfficial() { try { return JSON.parse(localStorage.getItem('busgo_official') || 'null'); } catch { return null; } },
  setOfficial(token, official) {
    localStorage.setItem('busgo_official_token', token);
    localStorage.setItem('busgo_official', JSON.stringify(official));
  },
  logoutUser() { localStorage.removeItem('busgo_user_token'); localStorage.removeItem('busgo_user'); location.href = '/index.html'; },
  logoutOfficial() { localStorage.removeItem('busgo_official_token'); localStorage.removeItem('busgo_official'); location.href = '/official.html'; },
};

// Redirect helpers — call at the top of a page that needs a logged-in user/official
function requireUserAuth() {
  if (!Auth.getUserToken()) { location.href = '/index.html'; return false; }
  return true;
}
function requireOfficialAuth() {
  if (!Auth.getOfficialToken()) { location.href = '/official.html'; return false; }
  return true;
}

// Authenticated fetch — adds the right Bearer token automatically
async function api(path, opts = {}, as = 'user') {
  const token = as === 'official' ? Auth.getOfficialToken() : Auth.getUserToken();
  const headers = Object.assign({}, opts.headers || {});
  if (!(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(path, { ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Renders the shared top nav into <div id="nav"></div>. `active` = current page key.
function renderNav(active) {
  const el = document.getElementById('nav');
  if (!el) return;
  const user = Auth.getUser();

  el.outerHTML = `
  <div class="nav">
    <a class="brand" href="/search.html">🚌 BusGo</a>
    <div class="links">
      <a href="/search.html" class="${active === 'search' ? 'active' : ''}">Search buses</a>
      <a href="/bookings.html" class="${active === 'bookings' ? 'active' : ''}">My bookings</a>
      <a href="/official.html" class="${active === 'official' ? 'active' : ''}" style="margin-left:8px;">Official portal</a>
      ${user
        ? `<span class="user-chip">${user.name || user.phone}</span><button class="logout" onclick="Auth.logoutUser()">Log out</button>`
        : `<a href="/index.html" class="${active === 'login' ? 'active' : ''}">Log in</a>`}
    </div>
  </div>`;
}

function statusMsg(container, text, type = 'info') {
  container.innerHTML = `<div class="status-msg ${type}">${text}</div>`;
}

/**
 * Autocomplete with automatic fallback to manual entry.
 * Tries Google Places autocomplete as normal. If it fails (key not enabled
 * for Places, no billing, quota, etc — anything returning a non-2xx from
 * our /api/places/autocomplete), it swaps the input for a simple
 * "type the name, press Enter" flow that calls /api/places/manual instead.
 * No Google call succeeding is required for the app to keep working.
 *
 * inputId/sugId: the text input + suggestions dropdown container.
 * onPick(location): called with the resolved/created location row.
 */
function wireAutocompleteWithFallback(inputId, sugId, onPick) {
  const input = document.getElementById(inputId);
  const box = document.getElementById(sugId);
  if (!input) return;
  const sessionToken = crypto.randomUUID();
  let debounce;
  let placesBroken = false;

  function showManualFallback(reason) {
    placesBroken = true;
    box.innerHTML = `<div style="padding:10px;">
      <div style="color:var(--muted); font-size:0.8rem; margin-bottom:6px;">
        Location suggestions aren't available right now${reason ? ' (' + reason + ')' : ''}. Type the full place name and press the button.
      </div>
      <button type="button" class="small secondary" style="width:100%;" onclick="window.__acManualPick_${inputId}()">Use "${input.value}" as typed</button>
    </div>`;
    window[`__acManualPick_${inputId}`] = async () => {
      try {
        const resolved = await api('/api/places/manual', { method: 'POST', body: JSON.stringify({ name: input.value }) });
        box.innerHTML = '';
        onPick(resolved.location);
      } catch (e) {
        box.innerHTML = `<div style="padding:10px; color:var(--red); font-size:0.85rem;">${e.message}</div>`;
      }
    };
  }

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const val = input.value;
    if (val.length < 2) { box.innerHTML = ''; return; }

    if (placesBroken) { showManualFallback(); return; }

    debounce = setTimeout(async () => {
      try {
        const data = await api(`/api/places/autocomplete?input=${encodeURIComponent(val)}&session=${sessionToken}`);
        if (!data.predictions || data.predictions.length === 0) {
          showManualFallback('no matches found');
          return;
        }
        box.innerHTML = '';
        data.predictions.forEach(p => {
          const div = document.createElement('div');
          div.innerHTML = `<div class="main">${p.main_text || p.description}</div><div class="secondary">${p.secondary_text || ''}</div>`;
          div.onclick = async () => {
            input.value = p.description;
            box.innerHTML = '';
            const resolved = await api('/api/places/resolve', { method: 'POST', body: JSON.stringify({ place_id: p.place_id }) });
            onPick(resolved.location);
          };
          box.appendChild(div);
        });
      } catch (e) {
        console.warn('Places autocomplete unavailable, falling back to manual entry:', e.message);
        showManualFallback('Google Places not available on this API key');
      }
    }, 300);
  });

  document.addEventListener('click', (e) => { if (!input.contains(e.target) && !box.contains(e.target)) box.innerHTML = ''; });
}
