/* global supabase, XLSX, google */

function $(id) {
  return document.getElementById(id);
}

function setStatus(text, kind = 'info') {
  const el = $('status');
  if (!el) return;
  el.textContent = text;
  el.dataset.kind = kind;
}

function ensureConfigured() {
  if (!window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) {
    throw new Error('Supabase not configured. Edit web/config.js and set SUPABASE_URL and SUPABASE_ANON_KEY.');
  }
}

let client;
let allProjects = [];
let allPoints = [];

// Map state
let map;
let projectMarkers = [];
let pointMarkers = [];
let mapReady = false;

function hasMapsKey() {
  return Boolean(window.GOOGLE_MAPS_API_KEY && window.GOOGLE_MAPS_API_KEY.trim());
}

function showMapOverlay(text) {
  const overlay = $('mapOverlay');
  const overlayText = $('mapOverlayText');
  if (overlay) overlay.style.display = 'block';
  if (overlayText) overlayText.textContent = text;
}

function hideMapOverlay() {
  const overlay = $('mapOverlay');
  if (overlay) overlay.style.display = 'none';
}

function loadGoogleMaps() {
  if (!hasMapsKey()) {
    showMapOverlay('Google Maps API key missing. Set GOOGLE_MAPS_API_KEY in web/config.js.');
    return;
  }

  // If already loaded
  if (window.google && window.google.maps) {
    initMap();
    return;
  }

  window.__initMap = () => {
    initMap();
  };

  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
    window.GOOGLE_MAPS_API_KEY
  )}&callback=__initMap`;
  script.async = true;
  script.defer = true;
  script.onerror = () => {
    showMapOverlay('Failed to load Google Maps. Check API key + allowed referrers.');
  };
  document.head.appendChild(script);
}

function initMap() {
  try {
    if (!window.google || !window.google.maps) {
      showMapOverlay('Google Maps library not available.');
      return;
    }

    const vancouver = { lat: 49.2827, lng: -123.1207 };
    map = new google.maps.Map($('map'), {
      center: vancouver,
      zoom: 11,
      mapTypeControl: true,
      mapTypeControlOptions: {
        position: google.maps.ControlPosition.TOP_RIGHT,
        style: google.maps.MapTypeControlStyle.HORIZONTAL_BAR,
        mapTypeIds: ['roadmap', 'satellite'],
      },
      streetViewControl: false,
      fullscreenControl: true,
      clickableIcons: false,
      styles: [
        // Hide surrounding businesses / POIs and most labels.
        { featureType: 'poi', stylers: [{ visibility: 'off' }] },
        { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
        { featureType: 'poi.park', stylers: [{ visibility: 'off' }] },
        { featureType: 'transit', stylers: [{ visibility: 'off' }] },
        { featureType: 'administrative', elementType: 'labels', stylers: [{ visibility: 'off' }] },
        { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
      ],
    });

    mapReady = true;
    hideMapOverlay();

    // Render if already loaded data
    renderMapForSelection($('projectSelect')?.value || '');
  } catch (e) {
    showMapOverlay(e?.message || String(e));
  }
}

function clearMarkers(arr) {
  for (const m of arr) {
    try {
      m.setMap(null);
    } catch (_) {}
  }
  arr.length = 0;
}

function centroidForProject(projectId) {
  const pts = allPoints.filter(
    (p) => p.project_id === projectId && !p.deleted && p.lat != null && p.lng != null
  );
  if (!pts.length) return null;
  const sum = pts.reduce(
    (acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }),
    { lat: 0, lng: 0 }
  );
  return { lat: sum.lat / pts.length, lng: sum.lng / pts.length };
}

function boundsForPoints(points) {
  if (!points.length) return null;
  const b = new google.maps.LatLngBounds();
  for (const p of points) {
    if (p.lat == null || p.lng == null) continue;
    b.extend({ lat: p.lat, lng: p.lng });
  }
  return b;
}

function renderProjectPins() {
  if (!mapReady) return;

  clearMarkers(projectMarkers);

  for (const proj of allProjects) {
    const c = centroidForProject(proj.id);
    if (!c) continue;

    const marker = new google.maps.Marker({
      map,
      position: c,
      title: `${proj.name} – ${proj.address || ''}`,
      label: {
        text: proj.name,
        color: '#031016',
        fontWeight: '700',
        fontSize: '11px',
      },
    });

    marker.addListener('click', () => {
      if ($('projectSelect')) {
        $('projectSelect').value = proj.id;
        onSelectionChanged();
      }
    });

    projectMarkers.push(marker);
  }
}

function renderPointPins(projectId) {
  if (!mapReady) return;
  clearMarkers(pointMarkers);

  if (!projectId) return;

  const pts = allPoints
    .filter((p) => p.project_id === projectId && !p.deleted && p.lat != null && p.lng != null)
    .sort((a, b) => (a.point_index || 0) - (b.point_index || 0));

  if (!pts.length) {
    setStatus('No GPS points found for this project (or lat/lng missing).', 'error');
  }

  for (const p of pts) {
    const marker = new google.maps.Marker({
      map,
      position: { lat: p.lat, lng: p.lng },
      title: `${p.point_index} ${p.descriptor || ''}`,
      label: {
        text: (p.descriptor || '').slice(0, 2).toUpperCase(),
        color: '#031016',
        fontWeight: '700',
        fontSize: '10px',
      },
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 6,
        fillColor: '#06b6d4',
        fillOpacity: 1,
        strokeColor: '#031016',
        strokeWeight: 1,
      },
    });
    pointMarkers.push(marker);
  }

  const b = boundsForPoints(pts);
  if (b) {
    map.fitBounds(b, 60);
  }
}

function renderMapForSelection(selectedProjectId) {
  if (!mapReady) return;

  if (!selectedProjectId) {
    // Main screen: show all project centroids
    renderProjectPins();
    clearMarkers(pointMarkers);

    // Fit bounds around all projects
    const centers = allProjects
      .map((p) => ({ id: p.id, c: centroidForProject(p.id) }))
      .filter((x) => x.c);

    if (centers.length) {
      const b = new google.maps.LatLngBounds();
      for (const x of centers) b.extend(x.c);
      map.fitBounds(b, 80);
    }
    return;
  }

  // Project view: zoom to project and show its points
  renderProjectPins();
  renderPointPins(selectedProjectId);
}

async function initClient() {
  ensureConfigured();
  client = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

  const { data } = await client.auth.getSession();
  if (data?.session) {
    onSignedIn();
  } else {
    onSignedOut();
  }

  client.auth.onAuthStateChange((_event, session) => {
    if (session) onSignedIn();
    else onSignedOut();
  });
}

function onSignedIn() {
  $('topbar').style.display = 'flex';
  $('loginPane').style.display = 'none';
  $('dashboard').style.display = 'block';
  setStatus('Signed in.', 'ok');
  loadGoogleMaps();
  refresh().catch((e) => setStatus(e.message || String(e), 'error'));
}

function onSignedOut() {
  $('topbar').style.display = 'none';
  $('loginPane').style.display = 'block';
  $('dashboard').style.display = 'none';
  setStatus('Signed out.', 'muted');
  clearMarkers(projectMarkers);
  clearMarkers(pointMarkers);
  showMapOverlay('Sign in and configure Google Maps API key to enable map pins.');
}

async function signIn(email, password) {
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

async function signOut() {
  await client.auth.signOut();
}

// Log out when the tab/window is closed.
window.addEventListener('beforeunload', () => {
  try {
    client.auth.signOut();
  } catch {
    // Ignore unload errors; session will be cleared on next load if signOut succeeds.
  }
});

async function fetchAllProjects() {
  const { data, error } = await client
    .from('projects')
    .select('id,name,address,created_at,device_id')
    // Keep project list stable and easy to scan
    .order('name', { ascending: true });
  if (error) throw error;

  // If some names are null/blank, do a safe local fallback sort.
  return (data || []).slice().sort((a, b) =>
    String(a?.name || '').localeCompare(String(b?.name || ''), undefined, {
      numeric: true,
      sensitivity: 'base',
    })
  );
}

async function fetchAllPoints() {
  const { data, error } = await client
    .from('data_points')
    .select('id,project_id,point_index,lat,lng,descriptor,created_at,source,deleted')
    .order('project_id', { ascending: true })
    .order('point_index', { ascending: true });
  if (error) throw error;
  return data || [];
}

function buildRows(projects, points, selectedProjectId) {
  return points
    .filter((p) => !selectedProjectId || p.project_id === selectedProjectId)
    .filter((p) => !p.deleted)
    .map((p) => ({
      id: p.id,
      project_id: p.project_id,
      point_index: p.point_index,
      descriptor: p.descriptor || '',
      lat: p.lat,
      lng: p.lng,
      source: p.source,
      created_at: p.created_at,
    }));
}

function renderProjectSelect(projects) {
  const select = $('projectSelect');
  select.innerHTML = '';

  const optAll = document.createElement('option');
  optAll.value = '';
  optAll.textContent = 'All projects (map pins)';
  select.appendChild(optAll);

  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name} — ${p.address || 'No address'}`;
    select.appendChild(opt);
  }
}

function renderProjectList(projects) {
  const list = $('projectList');
  list.innerHTML = '';

  const selectedId = $('projectSelect')?.value || '';

  for (const p of projects) {
    // Use a div (not a button) to avoid invalid nested <button> inside <button>
    const item = document.createElement('div');
    item.className = 'project-item' + (selectedId === p.id ? ' selected' : '');
    item.dataset.projectId = p.id;
    item.setAttribute('role', 'button');
    item.tabIndex = 0;

    item.innerHTML = `
      <div class="project-head">
        <div class="project-name">${escapeHtml(p.name)}</div>
        <button type="button" class="btn project-edit" data-action="edit">Edit Project</button>
      </div>
      <div class="project-address">${escapeHtml(p.address || 'No address')}</div>
    `;

    const handleActivate = () => {
      $('projectSelect').value = p.id;
      onSelectionChanged();
    };

    item.addEventListener('click', (ev) => {
      const target = ev.target;
      if (target && target.dataset && target.dataset.action === 'edit') {
        ev.preventDefault();
        ev.stopPropagation();
        $('projectSelect').value = p.id;
        onSelectionChanged(false);
        openEditModal(p);
        return;
      }
      handleActivate();
    });

    item.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        handleActivate();
      }
    });

    list.appendChild(item);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDateTimeLocal(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);

  const pad2 = (n) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());

  // Format: (Year-month-day) (24hr time)
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

function renderTable(rows) {
  const tbody = $('pointsTable').querySelector('tbody');
  tbody.innerHTML = '';

  for (const r of rows) {
    const tr = document.createElement('tr');

    const cols = ['point_index', 'descriptor', 'lat', 'lng', 'source', 'created_at'];
    for (const c of cols) {
      const td = document.createElement('td');
      const val = r[c];
      if (c === 'created_at') td.textContent = formatDateTimeLocal(val);
      else td.textContent = val === null || val === undefined ? '' : String(val);
      tr.appendChild(td);
    }

    // keep last column empty for now (editing/deletes happen in the Edit Project modal)
    const actionTd = document.createElement('td');
    actionTd.textContent = '';
    tr.appendChild(actionTd);

    tbody.appendChild(tr);
  }
}

function normalizePoints(points) {
  return (points || []).map((p) => ({
    ...p,
    point_index: p.point_index == null ? null : Number(p.point_index),
    lat: p.lat == null ? null : Number(p.lat),
    lng: p.lng == null ? null : Number(p.lng),
    deleted: !!p.deleted,
  }));
}

async function refresh(preserveSelectedProjectId = null) {
  setStatus('Loading from Supabase…', 'info');

  const currentSelected = $('projectSelect')?.value || '';
  const desiredSelected = preserveSelectedProjectId != null ? preserveSelectedProjectId : currentSelected;

  allProjects = await fetchAllProjects();
  allPoints = normalizePoints(await fetchAllPoints());

  renderProjectSelect(allProjects);

  // Restore selection (if it still exists)
  const exists = desiredSelected && allProjects.some((p) => p.id === desiredSelected);
  if ($('projectSelect')) $('projectSelect').value = exists ? desiredSelected : '';

  renderProjectList(allProjects);
  onSelectionChanged(false);

  setStatus(`Loaded ${allProjects.length} projects, ${allPoints.length} points.`, 'ok');
}

function updateProjectListSelection(selectedProjectId) {
  const list = $('projectList');
  if (!list) return;
  const items = list.querySelectorAll('.project-item');
  for (const el of items) {
    const pid = el.dataset.projectId;
    if (pid && pid === selectedProjectId) el.classList.add('selected');
    else el.classList.remove('selected');
  }
}

function onSelectionChanged(renderStatus = true) {
  const selectedProjectId = $('projectSelect').value || '';
  const rows = buildRows(allProjects, allPoints, selectedProjectId);
  renderTable(rows);
  renderMapForSelection(selectedProjectId);
  updateProjectListSelection(selectedProjectId);
  if (renderStatus) setStatus(`Showing ${rows.length} points.`, 'ok');
}

function selectedProject() {
  const id = $('projectSelect')?.value || '';
  return allProjects.find((p) => p.id === id) || null;
}

// Edit state (changes are staged locally; only persisted on Save)
let editState = null;

function openEditModal(project) {
  editState = {
    projectId: project.id,
    originalName: project.name || '',
    originalAddress: project.address || '',
    name: project.name || '',
    address: project.address || '',
    deletePointIds: new Set(),
  };

  $('editModalSubtitle').textContent = `${project.name} — ${project.address || 'No address'}`;
  $('editProjectName').value = editState.name;
  $('editProjectAddress').value = editState.address;
  $('editModalBackdrop').style.display = 'flex';

  renderEditPointsTable();
}

function closeEditModal() {
  $('editModalBackdrop').style.display = 'none';
  editState = null;
}

function isEditModalOpen() {
  return $('editModalBackdrop')?.style.display === 'flex';
}

function currentEditRows() {
  if (!editState) return [];
  const rows = buildRows(allProjects, allPoints, editState.projectId)
    .filter((r) => !editState.deletePointIds.has(r.id))
    .sort((a, b) => (a.point_index || 0) - (b.point_index || 0));

  // Re-number sequentially for display (staged resequence)
  return rows.map((r, idx) => ({ ...r, point_index: idx + 1 }));
}

function renderEditPointsTable() {
  const tbody = $('editPointsTable').querySelector('tbody');
  tbody.innerHTML = '';

  const rows = currentEditRows();

  for (const r of rows) {
    const tr = document.createElement('tr');
    const cols = ['point_index', 'descriptor', 'lat', 'lng', 'created_at'];
    for (const c of cols) {
      const td = document.createElement('td');
      const val = r[c];
      if (c === 'created_at') td.textContent = formatDateTimeLocal(val);
      else td.textContent = val === null || val === undefined ? '' : String(val);
      tr.appendChild(td);
    }

    const actionTd = document.createElement('td');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn small';
    btn.textContent = 'Delete';
    btn.addEventListener('click', () => {
      if (!editState) return;
      // This is just staging; no DB write yet.
      editState.deletePointIds.add(r.id);
      renderEditPointsTable();
      setStatus(`Staged delete for 1 point. Total staged deletes: ${editState.deletePointIds.size}.`, 'info');
    });
    actionTd.appendChild(btn);
    tr.appendChild(actionTd);

    tbody.appendChild(tr);
  }
}

async function handleSaveProjectEdits() {
  if (!editState) {
    setStatus('No project is currently being edited.', 'error');
    return;
  }

  // Pull latest input values into editState
  editState.name = $('editProjectName').value.trim();
  editState.address = $('editProjectAddress').value.trim();

  const rename = editState.name !== (editState.originalName || '');
  const readdr = editState.address !== (editState.originalAddress || '');
  const deletes = Array.from(editState.deletePointIds);

  if (!rename && !readdr && deletes.length === 0) {
    setStatus('No changes to save.', 'muted');
    return;
  }

  // One confirmation prompt for the save action (summarize changes)
  const parts = [];
  if (rename) parts.push(`rename project to "${editState.name}"`);
  if (readdr) parts.push('change project address');
  if (deletes.length) parts.push(`delete ${deletes.length} point(s) (will resequence point_index)`);

  if (!window.confirm(`Are you sure you want to ${parts.join(', ')}?`)) return;

  // Persist edits directly (no RPC required).
  if (rename || readdr) {
    const { error: projErr } = await client
      .from('projects')
      .update({ name: editState.name, address: editState.address })
      .eq('id', editState.projectId);
    if (projErr) throw projErr;
  }

  if (deletes.length) {
    // Soft-delete points so UI filters them out.
    const { error: delErr } = await client
      .from('data_points')
      .update({ deleted: true })
      .in('id', deletes);
    if (delErr) throw delErr;

    // Resequence remaining points for consistent ordering.
    const { data: remaining, error: remErr } = await client
      .from('data_points')
      .select('id,point_index')
      .eq('project_id', editState.projectId)
      .eq('deleted', false)
      .order('point_index', { ascending: true });
    if (remErr) throw remErr;

    if (remaining && remaining.length) {
      const results = await Promise.all(
        remaining.map((row, idx) =>
          client
            .from('data_points')
            .update({ point_index: idx + 1 })
            .eq('id', row.id)
        )
      );
      const reseqError = results.find((r) => r?.error)?.error;
      if (reseqError) throw reseqError;
    }
  }

  // Refresh + keep the edited project selected so the main project screen + map update immediately
  await refresh(editState.projectId);

  // Force a re-render for the selected project (table + map) right after data refresh.
  // (Some browsers won't visually repaint until after modal/alert interactions.)
  onSelectionChanged(false);

  // Close the modal after saving so the updated main screen is immediately visible.
  closeEditModal();

  setStatus('Saved changes to the database.', 'ok');
}

function exportCsv(rows) {
  const cols = Object.keys(rows[0] || {
    point_index: '',
    descriptor: '',
    lat: '',
    lng: '',
    source: '',
    deleted: '',
    created_at: '',
  });

  const escape = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    if (/[\",\n]/.test(s)) return '"' + s.replace(/\"/g, '""') + '"';
    return s;
  };

  const lines = [cols.join(',')];
  for (const r of rows) {
    lines.push(cols.map((c) => escape(r[c])).join(','));
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'survey_export.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportXlsx(rows) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'data_points');
  XLSX.writeFile(wb, 'survey_export.xlsx');
}

window.addEventListener('DOMContentLoaded', () => {
  loadGoogleMaps();

  // Modal wiring (use delegation so it survives any DOM quirks)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isEditModalOpen()) {
      closeEditModal();
    }
  });

  document.addEventListener('click', (e) => {
    const t = e.target;

    // Close button
    if (t && t.id === 'editModalCloseBtn') {
      e.preventDefault();
      closeEditModal();
      return;
    }

    // Backdrop click
    if (t && t.id === 'editModalBackdrop') {
      closeEditModal();
      return;
    }

    // Save button
    if (t && t.id === 'saveProjectBtn') {
      e.preventDefault();
      handleSaveProjectEdits().catch((err) => setStatus(err?.message || String(err), 'error'));
      return;
    }
  });

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      setStatus('Signing in…', 'info');
      await signIn($('email').value.trim(), $('password').value);
    } catch (err) {
      setStatus(err?.message || String(err), 'error');
    }
  });

  $('logoutBtn').addEventListener('click', async () => {
    try {
      await signOut();
    } catch (err) {
      setStatus(err?.message || String(err), 'error');
    }
  });

  $('refreshBtn').addEventListener('click', () => {
    refresh().catch((e) => setStatus(e.message || String(e), 'error'));
  });

  $('projectSelect').addEventListener('change', () => {
    onSelectionChanged();
  });

  $('exportCsvBtn').addEventListener('click', () => {
    const rows = buildRows(allProjects, allPoints, $('projectSelect').value || '');
    exportCsv(rows);
  });

  $('exportXlsxBtn').addEventListener('click', () => {
    const rows = buildRows(allProjects, allPoints, $('projectSelect').value || '');
    exportXlsx(rows);
  });

  initClient().catch((e) => setStatus(e.message || String(e), 'error'));
});
