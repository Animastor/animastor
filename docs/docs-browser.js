// Animastor docs browser — lightweight, no-build, hash-routed.
// Renders the repository docs/ tree as navigable markdown pages.
(function () {
  'use strict';

  /* ── File tree (hardcoded from docs/ directory listing) ── */
  var TREE = {
    'README.md': 1,
    'CHANGELOG.md': 1,
    'VISION.md': 1,
    'DONT_DO.md': 1,
    'architectural-essence.md': 1,
    'frontend-backend-audit.md': 1,
    'backend-dead-code-cleanup.md': 1,
    'Animastor_Близкие_горизонты.md': 1,
    '01-overview': {
      'README.md': 1,
      'ARCHITECTURE.md': 1,
      'DATA_FLOW.md': 1,
      'PROJECT_STRUCTURE.md': 1,
      'SYSTEM_MAP.md': 1,
      'SYSTEM_OVERVIEW.md': 1
    },
    '02-orchestration': {
      'README.md': 1,
      'ORCHESTRATION.md': 1,
      'AUDIO_ORCH_ARCHITECTURAL_FIXES.md': 1,
      'AUDIO_ORCH_ARCHITECTURAL_TODO.md': 1,
      'AUDIO_VIDEO_SYNC.md': 1,
      'ORCHESTRATION_AUDIT_2026-07-27.md': 1,
      'ORCHESTRATION_FOLLOWUP_REVIEW_2026-07-27.md': 1,
      'ORCHESTRATION_STABILIZATION_RECOMMENDATIONS.md': 1,
      'ORCHESTRATION_TODO.md': 1,
      'VIDEO_ORCHESTRATION.md': 1
    },
    '03-audit': {
      'README.md': 1,
      'ARCHITECTURAL_AUDIT.md': 1,
      'ARCHITECTURAL_AUDIT_TODO.md': 1,
      'ARCHITECTURAL_DEBT.md': 1,
      'AUDIO_8_9_RACE_CONDITION.md': 1,
      'CATHEDRAL.md': 1,
      'CONFLICTING_SUBSYSTEMS.md': 1,
      'CONTEXT_POISONING_RULES_EXAMPLES.md': 1,
      'CROSS_PROMPT_CONSISTENCY.md': 1,
      'DELETE_LIFECYCLE_AUDIT.md': 1,
      'DEPENDENCY_ANALYSIS.md': 1,
      'DOCUMENTATION_AUDIT.md': 1,
      'PLAYER_AUDIO_MASTER_TIMELINE.md': 1,
      'PLAYER_AUDIO_MASTER_TIMELINE_TODO.md': 1,
      'PLAYER_AUDIT.md': 1
    },
    '04-planning': {
      'README.md': 1,
      'EXPERIMENTAL_BETA_RECONNAISSANCE_AUDIT.md': 1,
      'EXPERIMENTAL_BETA_REDTEAM_AUDIT.md': 1,
      'EXPERIMENTAL_BETA_VERSION.md': 1,
      'GOLDEN_BOOK_EVOLUTION.md': 1,
      'NEAR_HORIZONS_GAP_ANALYSIS.md': 1,
      'ROADMAP_6M.md': 1,
      'RunPod_Integration_GPU_Hub.md': 1,
      'TXT_IMPORT_STRUCTURE_V2.md': 1,
      'WORKFLOW_ROADMAP.md': 1
    },
    '05-frontend': {
      'README.md': 1,
      'EDITOR_ENTITY_CRUD.md': 1,
      'PLAYER_SEEK_ENGINEERING.md': 1,
      'PLAYER_STATE_MACHINE_ANDROID_WEB_PARITY_AUDIT.md': 1,
      'PLAYER_STATE_MACHINE_AUDIT_T6.md': 1,
      'PLAYER_STATE_MACHINE_DESIGN.md': 1,
      'PLAYER_STATE_MACHINE_T4_MANUAL_REGRESSION.md': 1,
      'PLAYER_STATE.md': 1,
      'PROGRESS_HANDOFF.md': 1,
      'SCENE_LENGTH_REFACTOR.md': 1,
      'TASK_ARCHITECTURE.md': 1,
      'VIDEO_LOADING_RESEARCH.md': 1
    },
    '06-workflows': {
      'README.md': 1,
      'CONNECTOR_ARCHITECTURE.md': 1,
      'CONNECTORS.md': 1,
      'SCENE_PIPELINE.md': 1,
      'UNIT_SPLIT_POST_STEP.md': 1,
      'WORKFLOW_ARCHITECTURE.md': 1,
      'WORKFLOW_ASSISTANT_VISION.md': 1,
      'WORKFLOWS.md': 1
    },
    '07-agents-and-generators': {
      'README.md': 1,
      'AGENT_PROMPT_PROFILES.md': 1,
      'AGENTS.md': 1,
      'AI_PROFILE_AUTO_SELECTION.md': 1,
      'COREFERENCE_ARCHITECTURE_REVIEW.md': 1,
      'COREFERENCE_RESOLUTION.md': 1,
      'COREFERENCE_TODO.md': 1,
      'DIALOGUE_TTS_PIPELINE.md': 1,
      'GENERATORS.md': 1,
      'IMAGINATION_UNIT.md': 1,
      'IMAGINATION_UNIT_VERIFICATION.md': 1,
      'IU_MODAL_REFACTORING.md': 1,
      'LANGUAGE_ARCHITECTURE.md': 1,
      'SYSTEM_PROMPT_RULES_MIGRATION.md': 1,
      'VBOOK_GENERATION_COVERAGE_TODO.md': 1
    },
    '08-mobile-web-migration': {
      'README.md': 1,
      'TODO.md': 1,
      '01-MIGRATION-STRATEGY.md': 1,
      '02-DESIGN-PRESERVATION-PRINCIPLES.md': 1,
      '03-MOBILE-WEB-ARCHITECTURE.md': 1,
      '04-MAPPING-TABLES.md': 1,
      '05-SCREEN-IMPLEMENTATION-ORDER.md': 1,
      '06-RISKS-AND-ALTERNATIVES.md': 1,
      '07-MOBILE-WEB-TESTER.md': 1
    },
    '09-desktop-migration': {
      'README.md': 1,
      '01-MIGRATION-PLAN.md': 1,
      '02-PROGRESS.md': 1
    },
    'architecture': {
      'README.md': 1,
      'ACCOUNT_WORKSPACE_CONCEPT.md': 1,
      'ACCOUNT_WORKSPACE_RECONNAISSANCE.md': 1,
      'ADMIN_SYSTEM_AI_RED_TEAM_AUDIT.md': 1,
      'ANDROID_WEB_PARITY.md': 1,
      'architecture-map.md': 1,
      'audit.md': 1,
      'AUTH_IMPLEMENTATION.md': 1,
      'decisions.md': 1,
      'EXPERIMENTAL_BETA_DOCKER_DEPLOYMENT_AUDIT.md': 1,
      'EXPERIMENTAL_BETA_DOCKER_DEPLOYMENT.md': 1,
      'EXPERIMENTAL_BETA_E2E_SMOKE_AUDIT.md': 1,
      'EXPERIMENTAL_BETA_IMPLEMENTATION_VERIFICATION.md': 1,
      'EXPERIMENTAL_BETA_PERSONAL_AI_PROVIDER.md': 1,
      'EXPERIMENTAL_BETA_PERSONAL_AI_PROVIDER_SECURITY_REVIEW.md': 1,
      'EXPERIMENTAL_BETA_PRIVATE_WORKER_AUDIT.md': 1,
      'EXPERIMENTAL_BETA_PRIVATE_WORKER_PHASE1_SECURITY_REVIEW.md': 1,
      'EXPERIMENTAL_BETA_PRIVATE_WORKER_PHASE2_SECURITY_REVIEW.md': 1,
      'EXPERIMENTAL_BETA_PRIVATE_WORKER_PHASE3_SECURITY_REVIEW.md': 1,
      'EXPERIMENTAL_BETA_PRIVATE_WORKER_RECONNAISSANCE.md': 1,
      'EXPERIMENTAL_BETA_READINESS_AUDIT.md': 1,
      'EXPERIMENTAL_BETA_WORKER_SETUP.md': 1,
      'recoverable-work-set.md': 1,
      'redis-failure-model.md': 1,
      'roadmap.md': 1,
      'technical-debt.md': 1,
      'work-list-rebuild-design.md': 1
    },
    '99-archive': {
      'README.md': 1,
      'ARCHITECTURE_REVIEW.md': 1,
      'LLM_AUDIT_CONTEXT.md': 1,
      'REGENERATION_SYSTEM_TODO.md': 1,
      'TODO_IMMEDIATE.md': 1,
      'TODO_TODAY.md': 1,
      '02-orchestration': {
        'AUDIO_ORCHESTRATOR.md': 1,
        'GPU_HUB_CLEANUP.md': 1,
        'M5_COMPETING_WRITERS.md': 1,
        'ORCHESTRATOR_ARCHITECTURE_WITH_AUDIO.md': 1,
        'ORCHESTRATOR_FACADE_PR.md': 1,
        'ORCHESTRATOR_LIFECYCLE.md': 1,
        'REGENERATION_SYSTEM.md': 1,
        'STATE_WRITERS_MAP.md': 1
      },
      '03-audit': {
        'AUDIO_ORCH_INTEGRATION_TODO.md': 1,
        'CAPACITY_AND_COMPLEXITY.md': 1,
        'ORCHESTRATION_AUDIT_TODO.md': 1,
        'ORCHESTRATION_CONSOLIDATION_AUDIT.md': 1,
        'ORCHESTRATION_CONSOLIDATION_TODO.md': 1,
        'ORCHESTRATION_FULL_AUDIT.md': 1,
        'ORCHESTRATION_STABILIZATION_AUDIT.md': 1,
        'ORCHESTRATION_STABILIZATION_TODO.md': 1,
        'ORCHESTRATION_STABILIZATION_TODO_V2.md': 1,
        'ORCHESTRATION_SYSTEM_AUDIT.md': 1
      },
      '04-planning': {
        'MIGRATION_PLAN.md': 1,
        'ORCHESTRATOR_CONVERGENCE_TODO.md': 1
      }
    }
  };

  /* ── Markdown → HTML (lightweight parser) ── */
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderMd(src) {
    var lines = src.split('\n');
    var html = [];
    var i = 0;
    var inCode = false;
    var inList = false;
    var listType = '';
    var prevEmpty = false;

    function closeList() {
      if (inList) { html.push(listType === 'ol' ? '</ol>' : '</ul>'); inList = false; }
    }

    while (i < lines.length) {
      var line = lines[i];

      // Fenced code blocks
      if (/^```/.test(line)) {
        closeList();
        if (inCode) {
          html.push('</code></pre>');
          inCode = false;
        } else {
          var lang = line.slice(3).trim();
          html.push('<pre' + (lang ? ' class="lang-' + escapeHtml(lang) + '"' : '') + '><code>');
          inCode = true;
        }
        i++;
        continue;
      }
      if (inCode) {
        html.push(escapeHtml(line));
        i++;
        continue;
      }

      // Blank line
      if (/^\s*$/.test(line)) {
        closeList();
        prevEmpty = true;
        i++;
        continue;
      }

      // Headings
      var m = line.match(/^(#{1,6})\s+(.*)/);
      if (m) {
        closeList();
        var level = m[1].length;
        html.push('<h' + level + '>' + inlineMd(m[2]) + '</h' + level + '>');
        i++;
        continue;
      }

      // Horizontal rule
      if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
        closeList();
        html.push('<hr>');
        i++;
        continue;
      }

      // Unordered list
      m = line.match(/^(\s*)([-*+])\s+(.*)/);
      if (m) {
        if (!inList || listType !== 'ul') {
          closeList();
          html.push('<ul>');
          inList = true;
          listType = 'ul';
        }
        html.push('<li>' + inlineMd(m[3]) + '</li>');
        i++;
        continue;
      }

      // Ordered list
      m = line.match(/^(\s*)\d+[.)]\s+(.*)/);
      if (m) {
        if (!inList || listType !== 'ol') {
          closeList();
          html.push('<ol>');
          inList = true;
          listType = 'ol';
        }
        html.push('<li>' + inlineMd(m[2]) + '</li>');
        i++;
        continue;
      }

      // Table (simple: | col | col |)
      if (/^\|/.test(line) && /\|/.test(line)) {
        closeList();
        var rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) {
          var cells = lines[i].split('|').slice(1, -1).map(function (c) { return c.trim(); });
          rows.push(cells);
          i++;
        }
        if (rows.length > 0) {
          html.push('<table>');
          html.push('<thead><tr>');
          rows[0].forEach(function (c) { html.push('<th>' + inlineMd(c) + '</th>'); });
          html.push('</tr></thead>');
          if (rows.length > 2) {
            html.push('<tbody>');
            for (var r = 2; r < rows.length; r++) {
              html.push('<tr>');
              rows[r].forEach(function (c) { html.push('<td>' + inlineMd(c) + '</td>'); });
              html.push('</tr>');
            }
            html.push('</tbody>');
          }
          html.push('</table>');
        }
        continue;
      }

      // Paragraph
      closeList();
      var para = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|```|\|[-*+]|\d+[.)]\s)/.test(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      if (para.length) {
        html.push('<p>' + inlineMd(para.join(' ')) + '</p>');
      }
    }
    closeList();
    if (inCode) html.push('</code></pre>');
    return html.join('\n');
  }

  function inlineMd(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/((https?:\/\/)[^\s<>")]+)/g, function (url) {
        return '<a href="' + url + '" target="_blank" rel="noopener">' + url + '</a>';
      });
  }

  /* ── Sidebar tree renderer ── */
  function renderTree(node, path, expanded) {
    var keys = Object.keys(node);
    keys.sort(function (a, b) {
      var aDir = typeof node[a] === 'object';
      var bDir = typeof node[b] === 'object';
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.localeCompare(b);
    });
    var ul = document.createElement('ul');
    keys.forEach(function (name) {
      var isDir = typeof node[name] === 'object';
      var full = path ? path + '/' + name : name;
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = '#/' + full;
      a.className = isDir ? 'docs-tree-dir' : 'docs-tree-file';
      if (isDir) {
        var icon = document.createElement('span');
        icon.className = 'docs-tree-icon';
        icon.textContent = expanded[full] ? '\u25BC' : '\u25B6';
        a.appendChild(icon);
      }
      a.appendChild(document.createTextNode(name));
      li.appendChild(a);
      if (isDir && expanded[full]) {
        li.appendChild(renderTree(node[name], full, expanded));
      }
      ul.appendChild(li);
    });
    return ul;
  }

  /* ── App state ── */
  var contentEl = document.getElementById('docs-content');
  var treeEl = document.getElementById('docs-tree');
  var breadcrumbEl = document.getElementById('docs-breadcrumb');
  var toggleBtn = document.getElementById('docs-sidebar-toggle');
  var sidebarEl = document.querySelector('.docs-sidebar');
  var expandedDirs = {};
  var cache = {};

  function getHash() {
    var h = location.hash || '#/';
    return h.slice(2); // remove '#/'
  }

  function setHash(path) {
    location.hash = '#/' + path;
  }

  function isDir(name) {
    var node = getNode(name);
    return node !== null && typeof node === 'object';
  }

  function getNode(path) {
    if (!path) return TREE;
    var parts = path.split('/');
    var node = TREE;
    for (var i = 0; i < parts.length; i++) {
      if (typeof node !== 'object' || !(parts[i] in node)) return null;
      node = node[parts[i]];
    }
    return node;
  }

  function fetchFile(path) {
    if (cache[path]) return Promise.resolve(cache[path]);
    return fetch('/docs/' + path)
      .then(function (r) {
        if (!r.ok) throw new Error('Not found');
        return r.text();
      })
      .then(function (text) {
        cache[path] = text;
        return text;
      });
  }

  function buildBreadcrumb(path) {
    breadcrumbEl.innerHTML = '';
    var home = document.createElement('a');
    home.href = '#/';
    home.textContent = 'docs';
    home.className = 'docs-bc-link';
    breadcrumbEl.appendChild(home);

    if (!path) return;
    var parts = path.split('/');
    var accum = '';
    parts.forEach(function (part, idx) {
      var sep = document.createElement('span');
      sep.className = 'docs-bc-sep';
      sep.textContent = ' / ';
      breadcrumbEl.appendChild(sep);
      accum += (accum ? '/' : '') + part;
      if (idx < parts.length - 1) {
        var link = document.createElement('a');
        link.href = '#/' + accum;
        link.textContent = part;
        link.className = 'docs-bc-link';
        breadcrumbEl.appendChild(link);
      } else {
        var span = document.createElement('span');
        span.className = 'docs-bc-current';
        span.textContent = part;
        breadcrumbEl.appendChild(span);
      }
    });
  }

  function renderDir(path) {
    var node = getNode(path);
    if (!node || typeof node !== 'object') {
      contentEl.innerHTML = '<p>Not found.</p>';
      return;
    }

    var html = '';
    if (path) {
      html += '<h1>' + escapeHtml(path.split('/').pop()) + '</h1>';
    } else {
      html += '<h1>Documentation</h1>';
    }

    // Try to render README.md for this directory
    var readmePath = path ? path + '/README.md' : 'README.md';
    var self = this;
    fetchFile(readmePath).then(function (text) {
      // Render README as intro
      var readmeHtml = '<div class="docs-readme">' + renderMd(text) + '</div>';
      // Build directory listing
      var listHtml = '<div class="docs-dir-list">';
      var keys = Object.keys(node);
      keys.sort(function (a, b) {
        var aDir = typeof node[a] === 'object';
        var bDir = typeof node[b] === 'object';
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a.localeCompare(b);
      });
      keys.forEach(function (name) {
        if (name === 'README.md') return; // already rendered
        var isD = typeof node[name] === 'object';
        var full = path ? path + '/' + name : name;
        var displayName = isD ? name + '/' : name;
        listHtml += '<a class="docs-dir-item' + (isD ? ' docs-dir-item--dir' : '') + '" href="#/' + full + '">';
        listHtml += isD ? '<span class="docs-tree-icon">\u25BC</span> ' : '';
        listHtml += escapeHtml(displayName);
        listHtml += '</a>';
      });
      listHtml += '</div>';
      contentEl.innerHTML = readmeHtml + listHtml;
      contentEl.scrollTop = 0;
    }).catch(function () {
      // No README — just list
      var listHtml = '';
      keys.forEach(function (name) {
        var isD = typeof node[name] === 'object';
        var full = path ? path + '/' + name : name;
        var displayName = isD ? name + '/' : name;
        listHtml += '<a class="docs-dir-item' + (isD ? ' docs-dir-item--dir' : '') + '" href="#/' + full + '">';
        listHtml += isD ? '<span class="docs-tree-icon">\u25BC</span> ' : '';
        listHtml += escapeHtml(displayName);
        listHtml += '</a>';
      });
      contentEl.innerHTML = '<h1>' + escapeHtml(path || 'Documentation') + '</h1><div class="docs-dir-list">' + listHtml + '</div>';
      contentEl.scrollTop = 0;
    });
  }

  function renderFile(path) {
    fetchFile(path).then(function (text) {
      contentEl.innerHTML = '<div class="docs-md">' + renderMd(text) + '</div>';
      contentEl.scrollTop = 0;
    }).catch(function () {
      contentEl.innerHTML = '<p>File not found: ' + escapeHtml(path) + '</p>';
    });
  }

  function updateTree() {
    treeEl.innerHTML = '';
    treeEl.appendChild(renderTree(TREE, '', expandedDirs));
  }

  function route() {
    var path = getHash();
    buildBreadcrumb(path);

    // Expand parent directories
    if (path) {
      var parts = path.split('/');
      var accum = '';
      for (var i = 0; i < parts.length - 1; i++) {
        accum += (accum ? '/' : '') + parts[i];
        expandedDirs[accum] = true;
      }
    }

    updateTree();

    if (!path) {
      renderDir('');
    } else if (isDir(path)) {
      expandedDirs[path] = !expandedDirs[path];
      updateTree();
      renderDir(path);
    } else {
      renderFile(path);
    }
  }

  /* ── Sidebar toggle (mobile) ── */
  if (toggleBtn) {
    toggleBtn.addEventListener('click', function () {
      sidebarEl.classList.toggle('docs-sidebar--open');
    });
  }

  /* ── Tree click delegation ── */
  treeEl.addEventListener('click', function (e) {
    var a = e.target.closest('a');
    if (!a) return;
    // Close sidebar on mobile after navigation
    if (window.innerWidth < 768) {
      sidebarEl.classList.remove('docs-sidebar--open');
    }
  });

  /* ── Init ── */
  window.addEventListener('hashchange', route);
  route();
})();
