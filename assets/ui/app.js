const $ = (selector) => document.querySelector(selector);
const parameters = new URLSearchParams(window.location.search);
const state = {
  project: parameters.get('project'),
  query: parameters.get('q') || '',
  tag: parameters.get('tag') || '',
  unblocked:
    parameters.get('unblocked') !== 'false' && !parameters.has('blockedBy'),
  blockedBy: parameters.get('blockedBy') || '',
};
let projects = [];
let boardSignature = '';
let projectsSignature = '';
let boardGeneration = 0;
let detailGeneration = 0;
let detailSelection = null;
let detailSignature = '';
let detailTab = 'document';
let debounce;
let polling = false;

function node(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes))
    element.setAttribute(name, value);
  for (const child of children.flat()) {
    if (child !== null && child !== undefined) element.append(child);
  }
  return element;
}

function humanize(name) {
  if (name === 'todo') return 'To do';
  return name.replaceAll('-', ' ').replace(/^./, (c) => c.toUpperCase());
}

function tags(values) {
  const color = {
    bug: 'rose',
    cli: 'blue',
    design: 'purple',
    research: 'purple',
    docs: 'blue',
    prototype: 'purple',
  };
  return node(
    'span',
    { class: 'tags' },
    values.map((tag) =>
      node('span', { class: 'tag', 'data-color': color[tag] || 'green' }, tag)
    )
  );
}

function assignee(name) {
  const initials = name
    ? [...name.trim().split(/\s+/)]
        .slice(0, 2)
        .map((part) => [...part][0])
        .join('')
    : '–';
  return node(
    'span',
    { class: 'assignee' },
    node(
      'span',
      { class: `avatar${name ? '' : ' none'}`, 'aria-hidden': 'true' },
      initials
    ),
    name || 'Unassigned'
  );
}

async function api(path, values = {}) {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(values)) {
    if (value !== '' && value !== null && value !== undefined)
      url.searchParams.set(key, value);
  }
  const response = await fetch(url);
  if (!response.ok) {
    const body = response.headers
      .get('content-type')
      ?.includes('application/json')
      ? await response.json()
      : null;
    throw new Error(
      body?.error?.message ||
        'Could not read tickets. Is the local server still running?'
    );
  }
  return response.json();
}

function showError(error) {
  $('#error').textContent = error.message || 'Could not load tickets.';
  $('#error').hidden = false;
}

function syncFilters() {
  $('#query').value = state.query;
  $('#unblocked').setAttribute('aria-pressed', String(state.unblocked));
  $('#clear').hidden =
    !state.query && !state.tag && !state.blockedBy && !state.unblocked;
  const url = new URL(window.location.href);
  url.search = '';
  if (state.project) url.searchParams.set('project', state.project);
  if (state.query) url.searchParams.set('q', state.query);
  if (state.tag) url.searchParams.set('tag', state.tag);
  url.searchParams.set('unblocked', String(state.unblocked));
  if (state.blockedBy) url.searchParams.set('blockedBy', state.blockedBy);
  window.history.replaceState(null, '', url);
}

function options(select, label, values, selected) {
  const signature = JSON.stringify([values, selected]);
  if (select.dataset.signature === signature) return;
  const choices = [...values];
  if (selected && !choices.includes(selected)) choices.push(selected);
  select.replaceChildren(
    node('option', { value: '' }, label),
    ...choices.map((value) => node('option', { value }, value))
  );
  select.value = selected;
  select.dataset.signature = signature;
}

async function refreshProjects() {
  const catalog = await api('/api/projects');
  projects = catalog.projects;
  if (!projects.some((p) => p.key === state.project)) {
    state.project = catalog.initialProject;
    boardSignature = '';
  }
  const signature = JSON.stringify([projects, state.project]);
  if (signature !== projectsSignature) {
    const groups = [];
    for (const scope of ['local', 'global']) {
      const choices = projects.filter((p) => p.scope === scope);
      if (!choices.length) continue;
      groups.push(
        node(
          'optgroup',
          { label: scope === 'local' ? 'Local project' : 'Global projects' },
          choices.map((p) => node('option', { value: p.key }, p.name))
        )
      );
    }
    $('#project').replaceChildren(...groups);
    $('#project').value = state.project || '';
    projectsSignature = signature;
  }
  const selected = projects.find((p) => p.key === state.project);
  $('#project-name').textContent = selected
    ? humanize(selected.name)
    : 'Tickets';
  $('#project-path').textContent = selected?.path || '';
  document.title = selected ? `${selected.name} · Tickets` : 'Tickets';
  $('#project').hidden = !selected;
  $('#filters').hidden = !selected;
  $('#empty').hidden = Boolean(selected);
  syncFilters();
}

function card(ticket) {
  const top = node(
    'span',
    { class: 'card-top' },
    `#${ticket.name.split('-')[0]}`
  );
  if (ticket.blockedBy.length)
    top.append(node('span', { class: 'blocked' }, 'Blocked'));
  const button = node(
    'button',
    {
      type: 'button',
      class: 'card',
      'aria-label': `${ticket.id}: ${ticket.title}`,
    },
    top,
    node('span', { class: 'card-title' }, ticket.title),
    ticket.tags.length ? tags(ticket.tags) : null,
    assignee(ticket.assignedTo)
  );
  button.addEventListener('click', () => openTicket(ticket));
  return button;
}

async function loadBoard() {
  const generation = ++boardGeneration;
  if (!state.project) {
    $('#board').replaceChildren();
    $('#diagnostics').hidden = true;
    return;
  }
  const project = state.project;
  try {
    const board = await api('/api/board', {
      project,
      q: state.query,
      tag: state.tag,
      unblocked: state.unblocked,
      blockedBy: state.blockedBy,
    });
    if (generation !== boardGeneration || project !== state.project) return;
    $('#error').hidden = true;
    options($('#tag'), 'All tags', board.tags, state.tag);
    options($('#blocked-by'), 'Blocked by…', board.blockers, state.blockedBy);
    const signature = JSON.stringify(board);
    if (signature !== boardSignature) {
      $('#board').replaceChildren(
        ...board.statuses.map((status) => {
          const tickets = board.tickets.filter(
            (ticket) => ticket.status === status
          );
          return node(
            'section',
            {
              class: 'column',
              'data-status': status,
              'aria-label': humanize(status),
            },
            node(
              'h2',
              {},
              node('span', { class: 'dot', 'aria-hidden': 'true' }),
              humanize(status)
            ),
            node(
              'div',
              { class: 'cards' },
              tickets.length
                ? tickets.map(card)
                : node('p', { class: 'empty-column' }, 'No matching tickets')
            )
          );
        })
      );
      if (!board.statuses.length)
        $('#board').append(
          node(
            'p',
            { class: 'empty-column' },
            'No status directories in this project.'
          )
        );
      $('#diagnostics').hidden = !board.diagnostics.length;
      $('#diagnostics ul').replaceChildren(
        ...board.diagnostics.map((d) =>
          node('li', {}, `${d.path}: ${d.message}`)
        )
      );
      boardSignature = signature;
    }
  } catch (error) {
    if (generation !== boardGeneration) return;
    $('#board').replaceChildren();
    boardSignature = '';
    $('#diagnostics').hidden = true;
    showError(error);
  }
}

function renderDetail(ticket) {
  const meta = node(
    'div',
    { class: 'detail-meta' },
    node(
      'div',
      {},
      node('span', { class: 'meta-label' }, 'Status'),
      node(
        'span',
        { class: 'status-label', 'data-status': ticket.status },
        node('span', { class: 'dot' }),
        humanize(ticket.status)
      )
    ),
    node(
      'div',
      {},
      node('span', { class: 'meta-label' }, 'Assigned to'),
      assignee(ticket.assignedTo)
    ),
    node(
      'div',
      {},
      node('span', { class: 'meta-label' }, 'Tags'),
      ticket.tags.length ? tags(ticket.tags) : 'None'
    )
  );
  const relationships = node('div', { class: 'relationships' });
  if (ticket.parent)
    relationships.append(
      node('p', {}, 'Parent: ', node('code', {}, ticket.parent))
    );
  for (const blocker of ticket.blockedBy)
    relationships.append(
      node('p', {}, 'Blocked by: ', node('code', {}, blocker))
    );
  const content = node('div');
  const tabs = node('div', {
    class: 'detail-tabs',
    'aria-label': 'Document format',
  });
  function selectTab(tab) {
    detailTab = tab;
    for (const button of tabs.children) {
      button.classList.toggle('active', button.dataset.tab === tab);
      button.setAttribute('aria-pressed', String(button.dataset.tab === tab));
    }
    if (tab === 'document') {
      const prose = node('div', { class: 'prose' });
      // Only server-generated markup from the restricted Markdown renderer.
      prose.innerHTML = ticket.html;
      content.replaceChildren(prose);
    } else {
      content.replaceChildren(
        node(
          'pre',
          { class: 'raw' },
          tab === 'markdown'
            ? ticket.body
            : JSON.stringify(ticket.metadata, null, 2)
        )
      );
    }
  }
  for (const [key, label] of [
    ['document', 'Document'],
    ['markdown', 'Markdown'],
    ['metadata', 'Metadata'],
  ]) {
    const button = node('button', { type: 'button', 'data-tab': key }, label);
    button.addEventListener('click', () => selectTab(key));
    tabs.append(button);
  }
  $('#detail-reference').textContent = ticket.name;
  $('#detail').replaceChildren(
    node('h1', { id: 'detail-title' }, ticket.title),
    meta,
    node('div', { class: 'detail-path' }, ticket.path),
    relationships,
    tabs,
    content
  );
  selectTab(detailTab);
}

async function refreshDetail() {
  if (!detailSelection || !$('#ticket').open) return;
  const generation = ++detailGeneration;
  try {
    const ticket = await api('/api/ticket', detailSelection);
    if (generation !== detailGeneration || !$('#ticket').open) return;
    const signature = JSON.stringify(ticket);
    if (signature !== detailSignature) {
      renderDetail(ticket);
      detailSignature = signature;
    }
  } catch (error) {
    if (generation !== detailGeneration || !$('#ticket').open) return;
    $('#detail').replaceChildren(
      node('h1', { id: 'detail-title' }, 'Ticket unavailable'),
      node('p', { role: 'alert', class: 'prose' }, error.message)
    );
    detailSignature = '';
  }
}

function openTicket(ticket) {
  detailSelection = {
    project: state.project,
    status: ticket.status,
    name: ticket.name,
  };
  detailSignature = '';
  detailTab = 'document';
  $('#detail-reference').textContent = ticket.name;
  $('#detail').replaceChildren(node('h1', { id: 'detail-title' }, 'Loading…'));
  $('#ticket').showModal();
  void refreshDetail();
}

function applyFilters() {
  syncFilters();
  void loadBoard();
}

$('#filters').addEventListener('submit', (event) => {
  event.preventDefault();
  clearTimeout(debounce);
  applyFilters();
});
$('#query').value = state.query;
$('#query').addEventListener('input', () => {
  state.query = $('#query').value;
  clearTimeout(debounce);
  debounce = setTimeout(applyFilters, 180);
});
$('#unblocked').addEventListener('click', () => {
  state.unblocked = !state.unblocked;
  if (state.unblocked) {
    state.blockedBy = '';
    $('#blocked-by').value = '';
  }
  applyFilters();
});
$('#tag').addEventListener('change', () => {
  state.tag = $('#tag').value;
  applyFilters();
});
$('#blocked-by').addEventListener('change', () => {
  state.blockedBy = $('#blocked-by').value;
  if (state.blockedBy) state.unblocked = false;
  applyFilters();
});
$('#clear').addEventListener('click', () => {
  clearTimeout(debounce);
  state.query = '';
  state.tag = '';
  state.blockedBy = '';
  state.unblocked = false;
  applyFilters();
});
$('#project').addEventListener('change', async () => {
  ++boardGeneration;
  state.project = $('#project').value;
  state.query = '';
  state.tag = '';
  state.blockedBy = '';
  boardSignature = '';
  try {
    await refreshProjects();
    await loadBoard();
  } catch (error) {
    showError(error);
  }
});
$('#close-ticket').addEventListener('click', () => $('#ticket').close());
$('#ticket').addEventListener('close', () => {
  ++detailGeneration;
  detailSelection = null;
});
$('#ticket').addEventListener('click', (event) => {
  if (event.target !== $('#ticket')) return;
  const bounds = $('#ticket').getBoundingClientRect();
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  )
    $('#ticket').close();
});

async function refresh() {
  if (polling) return;
  polling = true;
  try {
    await refreshProjects();
    await loadBoard();
    await refreshDetail();
  } catch (error) {
    showError(error);
  } finally {
    polling = false;
  }
}
void refresh();
window.setInterval(() => {
  if (!document.hidden) void refresh();
}, 3000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh();
});
