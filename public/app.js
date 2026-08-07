// ── Nearby: Device Identity ──────────────────────────────────────────
    const NEARBY_ADJECTIVES = [
      'Swift','Quick','Bright','Cool','Bold','Calm','Keen','Wise','Fast','Smart',
      'Sharp','Brave','Steady','Quiet','Lively','Merry','Nimble','Jolly','Proud','Vivid',
      'Eager','Sunny','Witty','Noble','Fierce','Gentle','Spry','Daring','Lucky','Zippy',
      'Crafty','Peppy','Sleek','Snappy','Deft','Zesty','Nifty','Sly','Gritty','Sassy',
      'Cheeky','Breezy','Perky','Crisp','Grand','Plucky','Dapper','Stout','Dandy','Sprightly'
    ];
    const NEARBY_ANIMALS = [
      'Penguin','Otter','Fox','Hawk','Wolf','Bear','Eagle','Tiger','Lion','Panda',
      'Rabbit','Falcon','Jaguar','Lynx','Moose','Raven','Seal','Whale','Zebra','Crane',
      'Badger','Bison','Cobra','Condor','Coyote','Dingo','Dolphin','Ferret','Gecko','Gorilla',
      'Heron','Ibis','Kestrel','Koala','Lemur','Leopard','Mink','Narwhal','Ocelot','Osprey',
      'Parrot','Peacock','Puffin','Quail','Rhino','Sloth','Stork','Toucan','Viper','Weasel'
    ];

    function nearbyGenerateName() {
      const adj = NEARBY_ADJECTIVES[Math.floor(Math.random() * NEARBY_ADJECTIVES.length)];
      const animal = NEARBY_ANIMALS[Math.floor(Math.random() * NEARBY_ANIMALS.length)];
      return `${adj} ${animal}`;
    }

    function nearbyGetIdentity() {
      let deviceId = localStorage.getItem('nearbyDeviceId');
      let displayName = localStorage.getItem('nearbyDisplayName');
      if (!deviceId) {
        deviceId = crypto.randomUUID();
        localStorage.setItem('nearbyDeviceId', deviceId);
      }
      if (!displayName) {
        displayName = nearbyGenerateName();
        localStorage.setItem('nearbyDisplayName', displayName);
      }
      return { deviceId, displayName };
    }

    function nearbySetDisplayName(name) {
      localStorage.setItem('nearbyDisplayName', name);
    }

    function nearbyIsEnabled() {
      return localStorage.getItem('nearbyEnabled') === 'true';
    }

    function nearbySetEnabled(val) {
      localStorage.setItem('nearbyEnabled', val ? 'true' : 'false');
    }

    // ── Nearby: Trusted Devices ──────────────────────────────────────────
    const NEARBY_TRUST_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

    function nearbyGetTrusted() {
      try {
        const raw = localStorage.getItem('nearbyTrusted');
        if (!raw) return [];
        const all = JSON.parse(raw);
        const now = Date.now();
        return all.filter(t => now - t.trustedAt < NEARBY_TRUST_MS);
      } catch { return []; }
    }

    function nearbyIsTrusted(deviceId) {
      return nearbyGetTrusted().some(t => t.deviceId === deviceId);
    }

    function nearbyTrustDevice(deviceId, displayName) {
      const existing = nearbyGetTrusted().filter(t => t.deviceId !== deviceId);
      existing.push({ deviceId, displayName, trustedAt: Date.now() });
      localStorage.setItem('nearbyTrusted', JSON.stringify(existing));
    }

    function nearbyRevokeTrust(deviceId) {
      const updated = nearbyGetTrusted().filter(t => t.deviceId !== deviceId);
      localStorage.setItem('nearbyTrusted', JSON.stringify(updated));
    }
    // ─────────────────────────────────────────────────────────────────────

    // Escape untrusted strings (peer names, file names) before innerHTML use
    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      ));
    }

    // Dark Mode
    const darkModeToggle = document.getElementById('darkModeToggle');
    const savedTheme = localStorage.getItem('theme');

    function setThemeIcon(isDark) {
      darkModeToggle.innerHTML = `<i data-feather="${isDark ? 'sun' : 'moon'}"></i>`;
      feather.replace();
    }

    // Apply saved theme or default to light mode
    if (savedTheme === 'dark') {
      document.body.classList.add('dark-mode');
    }

    // Render initial icon after feather is ready
    window.addEventListener('load', () => {
      feather.replace();
      setThemeIcon(document.body.classList.contains('dark-mode'));
    });

    // Toggle dark mode
    darkModeToggle.addEventListener('click', () => {
      document.body.classList.toggle('dark-mode');
      const isDark = document.body.classList.contains('dark-mode');
      setThemeIcon(isDark);
      localStorage.setItem('theme', isDark ? 'dark' : 'light');
    });

    // Settings Modal
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsModal = document.getElementById('settingsModal');
    const settingsModalClose = document.getElementById('settingsModalClose');
    const autoCopyToggle = document.getElementById('autoCopyToggle');
    const autoDownloadToggle = document.getElementById('autoDownloadToggle');
    const autoJoinToggle = document.getElementById('autoJoinToggle');
    const keepScreenAwakeToggle = document.getElementById('keepScreenAwakeToggle');

    // Load saved settings (auto-copy default on, auto-download default off, auto-join default on, keep awake default on)
    autoCopyToggle.checked = localStorage.getItem('autoCopyText') !== 'false';
    autoDownloadToggle.checked = localStorage.getItem('autoDownloadFiles') === 'true';
    autoJoinToggle.checked = localStorage.getItem('autoJoinRoom') !== 'false';
    keepScreenAwakeToggle.checked = localStorage.getItem('keepScreenAwake') !== 'false';

    autoCopyToggle.addEventListener('change', () => {
      localStorage.setItem('autoCopyText', autoCopyToggle.checked ? 'true' : 'false');
    });

    autoDownloadToggle.addEventListener('change', () => {
      localStorage.setItem('autoDownloadFiles', autoDownloadToggle.checked ? 'true' : 'false');
    });

    autoJoinToggle.addEventListener('change', () => {
      localStorage.setItem('autoJoinRoom', autoJoinToggle.checked ? 'true' : 'false');
    });

    keepScreenAwakeToggle.addEventListener('change', () => {
      localStorage.setItem('keepScreenAwake', keepScreenAwakeToggle.checked ? 'true' : 'false');
      if (!keepScreenAwakeToggle.checked) releaseWakeLock();
    });

    function openSettingsModal() {
      settingsModal.classList.add('show');
      document.body.style.overflow = 'hidden';
    }

    function closeSettingsModal() {
      settingsModal.classList.remove('show');
      document.body.style.overflow = '';
    }

    settingsBtn.addEventListener('click', openSettingsModal);
    settingsModalClose.addEventListener('click', closeSettingsModal);
    settingsModal.addEventListener('click', (e) => {
      if (e.target === settingsModal) closeSettingsModal();
    });

    // ── Nearby Settings JS ───────────────────────────────────────────────
    const nearbyEnabledToggle = document.getElementById('nearbyEnabledToggle');
    const nearbySettingsExpanded = document.getElementById('nearbySettingsExpanded');
    const nearbyNameDisplay = document.getElementById('nearbyNameDisplay');
    const nearbyEditNameBtn = document.getElementById('nearbyEditNameBtn');
    const nearbyNameInputRow = document.getElementById('nearbyNameInputRow');
    const nearbyNameInput = document.getElementById('nearbyNameInput');
    const nearbyNameSaveBtn = document.getElementById('nearbyNameSaveBtn');
    const nearbyTrustedHeader = document.getElementById('nearbyTrustedHeader');
    const nearbyTrustedList = document.getElementById('nearbyTrustedList');

    function nearbyRefreshSettingsUI() {
      const { displayName } = nearbyGetIdentity();
      nearbyNameDisplay.textContent = displayName;
      nearbyEnabledToggle.checked = nearbyIsEnabled();
      nearbySettingsExpanded.style.display = nearbyIsEnabled() ? 'block' : 'none';
      nearbyRenderTrustedList();
    }

    function nearbyRenderTrustedList() {
      const trusted = nearbyGetTrusted();
      nearbyTrustedHeader.style.display = trusted.length > 0 ? 'flex' : 'none';
      nearbyTrustedList.innerHTML = '';
      for (const t of trusted) {
        const item = document.createElement('div');
        item.className = 'nearby-trusted-item';
        const daysAgo = Math.floor((Date.now() - t.trustedAt) / 86400000);
        item.innerHTML = `
          <span>${escapeHtml(t.displayName)} <span style="color:var(--text-secondary);font-size:12px;">· trusted ${daysAgo === 0 ? 'today' : daysAgo + 'd ago'}</span></span>
          <button class="nearby-trusted-remove" data-id="${escapeHtml(t.deviceId)}">Remove</button>
        `;
        item.querySelector('button').addEventListener('click', () => {
          nearbyRevokeTrust(t.deviceId);
          nearbyRenderTrustedList();
        });
        nearbyTrustedList.appendChild(item);
      }
    }

    nearbyEnabledToggle.addEventListener('change', () => {
      nearbySetEnabled(nearbyEnabledToggle.checked);
      nearbySettingsExpanded.style.display = nearbyEnabledToggle.checked ? 'block' : 'none';
      nearbyUpdateTabVisibility();
      if (nearbyEnabledToggle.checked) {
        nearbyConnect();
      } else {
        nearbyDisconnect();
      }
    });

    nearbyEditNameBtn.addEventListener('click', () => {
      nearbyNameInput.value = nearbyGetIdentity().displayName;
      nearbyNameInputRow.style.display = 'flex';
      nearbyEditNameBtn.style.display = 'none';
      nearbyNameInput.focus();
    });

    nearbyNameSaveBtn.addEventListener('click', () => {
      const newName = nearbyNameInput.value.trim();
      if (!newName) return;
      nearbySetDisplayName(newName);
      nearbyNameDisplay.textContent = newName;
      nearbyNameInputRow.style.display = 'none';
      nearbyEditNameBtn.style.display = '';
      // Notify lobby of name change
      if (nearbyWs && nearbyWs.readyState === WebSocket.OPEN) {
        nearbyWs.send(JSON.stringify({ type: 'update-name', displayName: newName }));
      }
    });

    // Refresh settings UI each time the modal opens
    settingsBtn.addEventListener('click', nearbyRefreshSettingsUI);
    // ─────────────────────────────────────────────────────────────────────

    // Wake Lock — prevents screen from dimming during active transfers
    let wakeLock = null;

    async function acquireWakeLock() {
      if (!('wakeLock' in navigator)) return;
      if (localStorage.getItem('keepScreenAwake') === 'false') return;
      if (wakeLock) return; // already held
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } catch (e) {
        console.warn('Wake lock request failed:', e);
      }
    }

    function releaseWakeLock() {
      if (wakeLock) {
        wakeLock.release();
        wakeLock = null;
      }
    }

    let transferInProgress = false;

    window.addEventListener('beforeunload', (e) => {
      if (transferInProgress) {
        e.preventDefault();
      }
    });

    // Configuration
    const CONFIG = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
      ],
      p2pTimeout: 10000, // 10 seconds to establish P2P
      chunkSize: 16384, // 16KB chunks
      maxFileSize: 20 * 1024 * 1024 // 20MB limit for R2 fallback
    };

    // Fetch TURN credentials from worker (secret never touches client source)
    fetch('/api/turn-credentials')
      .then(r => r.json())
      .then(turnServers => {
        if (Array.isArray(turnServers) && turnServers.length > 0) {
          CONFIG.iceServers = CONFIG.iceServers.concat(turnServers);
        }
      })
      .catch(() => {}); // silently ignore — STUN-only fallback still works
    
    // State
    let ws = null;
    let pc = null;
    let dataChannel = null;
    let sessionId = null;
    let roomCode = null;
    let isSender = true;
    let selectedFiles = [];        // Array<File>
    let receivedFiles = [];        // {fileName, url}[] collected across a batch
    let pendingFileCount = 0;      // total files expected in current batch
    let receivedFileCount = 0;     // files completed so far in current batch
    let receivedChunks = [];
    let receivedSize = 0;
    let totalSize = 0;
    let fileName = '';
    let p2pTimeout = null;
    let isP2PConnected = false;
    let turnstileToken = null;
    let wsReconnectAttempts = 0;
    let wsReconnectTimeout = null;
    let isIntentionalClose = false;
    let pingInterval = null;

    // Elements
    const status = document.getElementById('status');
    const statusText = document.getElementById('statusText');
    const roomCodeEl = document.getElementById('roomCode');
    const statusBadge = document.getElementById('statusBadge');
    const qrModal = document.getElementById('qrModal');
    const qrModalClose = document.getElementById('qrModalClose');
    const modalRoomCode = document.getElementById('modalRoomCode');
    const qrcodeDiv = document.getElementById('qrcode');
    const qrInlineWrapper = document.getElementById('qrInlineWrapper');
    const qrInlineCodeEl = document.getElementById('qrInlineCode');
    const leftReceiveState = document.getElementById('leftReceiveState');
    const cookieBanner = document.getElementById('cookieBanner');
    const cookieBannerClose = document.getElementById('cookieBannerClose');
    const sendRoleBtn = document.getElementById('sendRoleBtn');
    const receiveRoleBtn = document.getElementById('receiveRoleBtn');
    const roleHint = document.getElementById('roleHint');
    const sendTypeSelector = document.getElementById('sendTypeSelector');
    const sendModeBtn = document.getElementById('sendModeBtn');
    const urlModeBtn = document.getElementById('urlModeBtn');
    const textModeBtn = document.getElementById('textModeBtn');
    const sendSection = document.getElementById('sendSection');
    const urlSection = document.getElementById('urlSection');
    const textSection = document.getElementById('textSection');
    const receiveSection = document.getElementById('receiveSection');
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');
    const fileInfo = document.getElementById('fileInfo');
    const fileList = document.getElementById('fileList');
    const fileNameEl = document.getElementById('fileName');
    const fileSizeEl = document.getElementById('fileSize');
    const sendBtn = document.getElementById('sendBtn');
    const urlInput = document.getElementById('urlInput');
    const pasteUrlBtn = document.getElementById('pasteUrlBtn');
    const sendUrlBtn = document.getElementById('sendUrlBtn');
    const textInput = document.getElementById('textInput');
    const pasteTextBtn = document.getElementById('pasteTextBtn');
    const clearTextBtn = document.getElementById('clearTextBtn');
    const sendTextBtn = document.getElementById('sendTextBtn');
    const roomInput = document.getElementById('roomInput');
    const joinBtn = document.getElementById('joinBtn');
    const progress = document.getElementById('progress');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    const errorDiv = document.getElementById('error');
    const toast = document.getElementById('toast');
    const popupOverlay = document.getElementById('popupOverlay');
    const popupModal = document.getElementById('popupModal');
    const telehostPromo = document.getElementById('telehostPromo');
    const receiveSuccessPanel = document.getElementById('receiveSuccessPanel');
    const successIcon = document.getElementById('successIcon');
    const successTitle = document.getElementById('successTitle');
    const successMeta = document.getElementById('successMeta');
    const successFileActions = document.getElementById('successFileActions');
    const successTextActions = document.getElementById('successTextActions');
    const successTextDisplay = document.getElementById('successTextDisplay');
    const successCopyBtn = document.getElementById('successCopyBtn');
    const successResetBtn = document.getElementById('successResetBtn');
    
    const receiveJoinForm = document.getElementById('receiveJoinForm');
    const receiveJoinedState = document.getElementById('receiveJoinedState');
    const receiveJoinedCode = document.getElementById('receiveJoinedCode');
    const changeRoomBtn = document.getElementById('changeRoomBtn');

    changeRoomBtn.addEventListener('click', () => {
      // Disconnect from current room
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
        ws = null;
      }
      roomCode = null;
      // Pre-fill the input with the current code so they can edit it
      roomInput.value = receiveJoinedCode.textContent;
      // Show the join form again
      receiveJoinedState.style.display = 'none';
      receiveJoinForm.style.display = '';
      roomInput.focus();
      roomInput.select();
    });

    // Render the selected files list with individual remove buttons
    function renderFileList() {
      fileList.innerHTML = '';
      if (selectedFiles.length === 0) {
        fileInfo.style.display = 'none';
        return;
      }
      selectedFiles.forEach((file, i) => {
        const row = document.createElement('div');
        row.className = 'file-row';
        row.innerHTML = `<span class="file-row-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span><span class="file-row-size">${formatFileSize(file.size)}</span><button class="file-row-remove" data-index="${i}" title="Remove">×</button>`;
        fileList.appendChild(row);
      });
      fileInfo.style.display = 'block';
      fileList.querySelectorAll('.file-row-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          selectedFiles.splice(parseInt(btn.dataset.index), 1);
          const dt = new DataTransfer();
          selectedFiles.forEach(f => dt.items.add(f));
          fileInput.files = dt.files;
          if (selectedFiles.length === 0) updateSendButton('waiting');
          renderFileList();
        });
      });
    }

    // Switch to receive tab and show "joined" state (hides code entry form)
    function activateReceiveJoined(code) {
      receiveRoleBtn.click();
      receiveJoinForm.style.display = 'none';
      receiveJoinedState.style.display = '';
      receiveJoinedCode.textContent = code;
      leftReceiveState.querySelector('.left-receive-sub').textContent = 'Waiting for sender to transfer files…';
    }

    // Show receive success panel (replaces right panel content)
    function showReceiveSuccess(type, data) {
      // Hide all normal right-panel content
      document.querySelector('.role-selector').style.display = 'none';
      roleHint.style.display = 'none';
      sendTypeSelector.style.display = 'none';
      sendSection.style.display = 'none';
      urlSection.style.display = 'none';
      textSection.style.display = 'none';
      receiveSection.style.display = 'none';
      progress.style.display = 'none';

      // Reset both action blocks
      successFileActions.style.display = 'none';
      successTextActions.style.display = 'none';

      if (type === 'files') {
        const files = Array.isArray(data) ? data : [data];
        successIcon.textContent = '📦';
        successTitle.textContent = files.length === 1 ? 'File Ready!' : `${files.length} Files Ready!`;
        successMeta.textContent = '';
        successFileActions.innerHTML = '';
        files.forEach(({ fileName: fn, url }) => {
          const a = document.createElement('a');
          a.href = url;
          a.download = fn;
          a.className = 'btn';
          a.textContent = `⬇ ${fn}`;
          successFileActions.appendChild(a);
        });
        if (files.length > 1) {
          const dlAll = document.createElement('button');
          dlAll.className = 'btn';
          dlAll.textContent = '⬇ Download All';
          dlAll.addEventListener('click', () => {
            successFileActions.querySelectorAll('a.btn').forEach(a => a.click());
          });
          successFileActions.appendChild(dlAll);
        }
        successFileActions.style.display = 'flex';
        if (localStorage.getItem('autoDownloadFiles') === 'true') {
          files.forEach(({ url, fileName: fn }) => {
            const a = document.createElement('a');
            a.href = url;
            a.download = fn;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          });
        }
      } else if (type === 'text') {
        successIcon.textContent = '📋';
        successTitle.textContent = 'Text Received!';
        successMeta.textContent = '';
        successTextDisplay.value = data.content;
        successTextActions.style.display = 'flex';
        if (localStorage.getItem('autoCopyText') !== 'false') {
          navigator.clipboard.writeText(data.content).then(() => showToast('Text copied to clipboard!'));
        }
      }

      telehostPromo.style.display = 'block';
      receiveSuccessPanel.classList.add('active');

      // Nearby: offer to trust the sender after a successful transfer
      if (nearbyLastTransferPeer) {
        nearbyOfferTrust(nearbyLastTransferPeer.deviceId, nearbyLastTransferPeer.displayName);
        nearbyLastTransferPeer = null;
      }
    }

    // Reset back to normal state
    successResetBtn.addEventListener('click', () => {
      receiveSuccessPanel.classList.remove('active');
      document.querySelector('.role-selector').style.display = '';
      roleHint.style.display = '';
      sendTypeSelector.style.display = '';
      // Clear inline styles set by showReceiveSuccess so CSS classes take over
      sendSection.style.display = '';
      urlSection.style.display = '';
      textSection.style.display = '';
      receiveSection.style.display = '';
      progress.style.display = '';
      // Reset receive section to show the join form again
      receiveJoinForm.style.display = '';
      receiveJoinedState.style.display = 'none';
      leftReceiveState.querySelector('.left-receive-sub').textContent = "Enter the code from the sender's screen";
      sendRoleBtn.click();
    });

    // Copy button in success panel
    successCopyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(successTextDisplay.value).then(() => {
        showToast('Copied to clipboard!');
      });
    });

    // Initialize
    init();

    // --- PWA: register service worker + handle share_target payload -----
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
          console.warn('[PWA] SW registration failed', err);
        });
      });
    }

    async function loadSharedPayload() {
      const params = new URLSearchParams(window.location.search);
      const shared = params.get('shared');
      if (!shared) return;

      // Strip the ?shared param so a manual refresh doesn't re-trigger this.
      const cleaned = window.location.pathname +
        (params.get('room') ? ('?room=' + params.get('room')) : '') +
        window.location.hash;
      history.replaceState(null, '', cleaned);

      if (shared === 'error' || shared === 'unavailable') {
        showError('Could not receive shared content. Please reload the app from your home screen and try again.');
        return;
      }
      if (!('caches' in window)) return;

      try {
        const cache = await caches.open('swiftdrop-share-v1');
        const manifestRes = await cache.match('/__shared__/manifest.json');
        if (!manifestRes) return;
        const manifest = await manifestRes.json();

        if (manifest.files && manifest.files.length > 0) {
          const loadedFiles = [];
          for (const meta of manifest.files) {
            const fileRes = await cache.match(meta.key);
            if (fileRes) {
              const blob = await fileRes.blob();
              loadedFiles.push(new File([blob], meta.name, { type: meta.type || blob.type || 'application/octet-stream' }));
            }
          }

          if (loadedFiles.length > 0) {
            sendModeBtn.click();
            selectedFiles = loadedFiles;
            try {
              const dt = new DataTransfer();
              loadedFiles.forEach(f => dt.items.add(f));
              fileInput.files = dt.files;
            } catch (_) {}

            renderFileList();

            if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
              updateSendButton('p2p');
            } else if (ws && ws.readyState === WebSocket.OPEN) {
              updateSendButton('connecting');
            } else {
              updateSendButton('waiting');
            }

            showToast(selectedFiles.length === 1
              ? ('Shared: ' + selectedFiles[0].name)
              : ('Shared ' + selectedFiles.length + ' files'));
          }
        } else if (manifest.url) {
          urlModeBtn.click();
          urlInput.value = manifest.url;
          urlInput.dispatchEvent(new Event('input'));
          showToast('Shared URL ready to send');
        } else if (manifest.text || manifest.title) {
          textModeBtn.click();
          textInput.value = [manifest.title, manifest.text].filter(Boolean).join('\n\n');
          textInput.dispatchEvent(new Event('input'));
          showToast('Shared text ready to send');
        }

        // Payload consumed — clear the cache so it isn't reused.
        const keys = await cache.keys();
        await Promise.all(keys.map((k) => cache.delete(k)));
      } catch (e) {
        console.error('[share] failed to load payload', e);
      }
    }
    loadSharedPayload();
    // --------------------------------------------------------------------

    // Helper function to update status badge
    function updateStatusBadge(state, message) {
      const badge = statusBadge;
      const icon = badge.querySelector('.status-icon');
      const text = badge.querySelector('.status-text');

      // Remove all badge classes
      badge.className = 'status-badge';
      status.className = 'status';

      switch(state) {
        case 'waiting':
          badge.classList.add('badge-waiting');
          icon.textContent = '⏳';
          text.textContent = message || 'Waiting for peer...';
          break;
        case 'connecting':
          badge.classList.add('badge-connecting');
          status.classList.add('connecting');
          icon.textContent = '🔄';
          text.textContent = message || 'Connecting...';
          break;
        case 'p2p':
          badge.classList.add('badge-p2p');
          status.classList.add('connected');
          roomCodeEl.classList.add('connected');
          icon.textContent = '✅';
          text.textContent = message || 'P2P Connected';
          break;
        case 'relay':
          badge.classList.add('badge-relay');
          status.classList.add('relay');
          icon.textContent = '☁️';
          text.textContent = message || 'Cloud Relay Active';
          break;
      }
    }

    // Helper function to update send button state
    function updateSendButton(state) {
      if (selectedFiles.length === 0) return;

      // Remove all button state classes
      sendBtn.className = 'btn';

      switch(state) {
        case 'waiting':
          sendBtn.classList.add('btn-waiting');
          sendBtn.disabled = true;
          sendBtn.textContent = 'Waiting for receiver...';
          break;
        case 'connecting':
          // Gray but clickable - allows skipping P2P attempt
          sendBtn.classList.add('btn-gray');
          sendBtn.disabled = false;
          sendBtn.textContent = 'Upload via Cloud';
          break;
        case 'p2p':
          // Active purple - P2P is ready
          sendBtn.classList.add('btn-active');
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send File (P2P)';
          break;
        case 'relay':
          // Blue highlighted - Cloud Relay active
          sendBtn.classList.add('btn-blue');
          sendBtn.disabled = false;
          sendBtn.textContent = 'Upload via Cloud';
          break;
      }
    }

    // Helper function to generate QR code in modal + inline panel
    function generateQRCode(roomCode) {
      qrcodeDiv.innerHTML = '';
      qrInlineCodeEl.innerHTML = '';

      const fullUrl = window.location.origin + window.location.pathname + '?room=' + roomCode;

      // Modal QR
      new QRCode(qrcodeDiv, {
        text: fullUrl,
        width: 220,
        height: 220,
        colorDark: '#667eea',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H
      });

      // Inline panel QR (desktop only, but harmless to generate on mobile)
      new QRCode(qrInlineCodeEl, {
        text: fullUrl,
        width: 148,
        height: 148,
        colorDark: '#667eea',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H
      });

      // Show inline wrapper (CSS hides it on mobile)
      qrInlineWrapper.style.display = '';
    }

    // Open QR modal
    function openQRModal() {
      if (!isSender) return; // Only senders can open modal
      modalRoomCode.textContent = roomCode;
      qrModal.classList.add('show');
      document.body.style.overflow = 'hidden'; // Prevent background scroll
    }

    // Close QR modal
    function closeQRModal() {
      qrModal.classList.remove('show');
      document.body.style.overflow = ''; // Restore scroll
    }

    // Client config (Turnstile sitekey) is served from /api/config so key
    // rotation never requires touching the static files.
    const clientConfigPromise = fetch('/api/config')
      .then((r) => r.json())
      .catch(() => ({}));

    let turnstileWidgetRendered = false;

    function waitForTurnstileApi() {
      return new Promise((resolve, reject) => {
        if (window.turnstile) return resolve();
        let waited = 0;
        const timer = setInterval(() => {
          if (window.turnstile) {
            clearInterval(timer);
            resolve();
          } else if ((waited += 100) >= 10000) {
            clearInterval(timer);
            reject(new Error('Turnstile not available'));
          }
        }, 100);
      });
    }

    async function ensureTurnstileWidget() {
      if (turnstileWidgetRendered) return;
      const { turnstileSiteKey } = await clientConfigPromise;
      if (!turnstileSiteKey) throw new Error('Turnstile not configured');
      await waitForTurnstileApi();
      window.turnstile.render('#turnstileWidget', {
        sitekey: turnstileSiteKey,
        theme: 'light',
        size: 'invisible',
        callback: window.onTurnstileSuccess
      });
      turnstileWidgetRendered = true;
    }

    // Turnstile helper functions
    async function getTurnstileToken() {
      await ensureTurnstileWidget();
      return new Promise((resolve, reject) => {
        try {
          // Execute Turnstile (invisible mode)
          window.turnstile.execute('#turnstileWidget', {
            callback: (token) => {
              turnstileToken = token;
              resolve(token);
            },
            'error-callback': () => {
              reject(new Error('Turnstile verification failed'));
            }
          });
        } catch (error) {
          console.error('Turnstile execution error:', error);
          reject(error);
        }
      });
    }

    // Turnstile success callback (called by Turnstile widget)
    window.onTurnstileSuccess = function(token) {
      turnstileToken = token;
    };

    // Cookie consent functions
    function checkCookieConsent() {
      const dismissed = localStorage.getItem('cookieConsentDismissed');
      if (!dismissed) {
        // Show banner after a short delay for better UX
        setTimeout(() => {
          cookieBanner.classList.add('show');
        }, 500);
      }
    }

    function dismissCookieBanner() {
      cookieBanner.classList.remove('show');
      localStorage.setItem('cookieConsentDismissed', 'true');
    }

    // URL validation and auto-prepend
    function validateAndPrepareURL(inputUrl) {
      let url = inputUrl.trim();

      // Auto-prepend https:// if no protocol
      if (url && !url.match(/^https?:\/\//i)) {
        url = 'https://' + url;
      }

      // Validate URL format with TLD check (2-6 letters, handles .co.uk etc)
      const urlPattern = /^https?:\/\/([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+\.[a-zA-Z]{2,6}(\/.*)?$/;

      if (!url || !urlPattern.test(url)) {
        return { valid: false, url: null };
      }

      // Additional validation using URL constructor and protocol whitelist
      try {
        const urlObj = new URL(url);
        // Only allow http: and https: protocols (prevent javascript:, data:, file:, etc.)
        if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
          return { valid: false, url: null };
        }
        return { valid: true, url };
      } catch (e) {
        return { valid: false, url: null };
      }
    }

    // Paste URL from clipboard
    async function pasteURLFromClipboard() {
      try {
        const text = await navigator.clipboard.readText();
        const result = validateAndPrepareURL(text);

        if (result.valid) {
          urlInput.value = result.url;
          showToast('URL pasted and validated!');

          // Enable send button if connected
          if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
            sendUrlBtn.disabled = false;
            sendUrlBtn.textContent = 'Send URL (P2P)';
          } else if (ws && ws.readyState === WebSocket.OPEN) {
            sendUrlBtn.disabled = false;
            sendUrlBtn.textContent = 'Send URL (via Cloud)';
          }
        } else {
          showError('Invalid URL in clipboard. Please check the format.');
        }
      } catch (error) {
        console.error('Clipboard access error:', error);
        showError('Could not access clipboard. Please paste manually.');
      }
    }

    function init() {
      // Check cookie consent on page load
      checkCookieConsent();

      // Check for auto-join via URL parameter
      const urlParams = new URLSearchParams(window.location.search);
      const autoJoinRoom = urlParams.get('room');

      if (autoJoinRoom && autoJoinRoom.length === 6) {
        // Auto-join the room from URL parameter
        isSender = false;
        roomCode = autoJoinRoom.toUpperCase();
        roomCodeEl.textContent = roomCode;
        connectWebSocket(roomCode);
        statusText.textContent = 'Joining room...';
        showToast('Joining room ' + roomCode + '...');

        activateReceiveJoined(roomCode);
      } else {
        // Normal sender flow
        isSender = true;
        roomCode = generateRoomCode();
        roomCodeEl.textContent = roomCode;
        generateQRCode(roomCode); // Generate QR code for modal
        connectWebSocket(roomCode);

        // Make status clickable for senders
        status.classList.add('clickable');
      }
    }
    
    function generateRoomCode() {
      const digits = new Uint32Array(6);
      crypto.getRandomValues(digits);
      return Array.from(digits, (d) => d % 10).join('');
    }
    
    function connectWebSocket(room, isReconnect = false) {
      // Prevent the outgoing ws's onclose from triggering a reconnect to the old room.
      // Without this, intentional closes (joinBtn, changeRoom, etc.) still fire onclose
      // after isIntentionalClose is reset, causing a stale reconnect loop that exhausts
      // wsReconnectAttempts and shows "Connection lost" on the new room.
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
      }

      // Always cancel any pending retry — we're opening a new connection right now.
      // This also prevents a stale scheduled retry from clobbering the new ws's handlers.
      clearTimeout(wsReconnectTimeout);
      wsReconnectTimeout = null;

      if (!isReconnect) {
        wsReconnectAttempts = 0;
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocol}//${window.location.host}/ws?room=${room}`);

      ws.onopen = () => {
        console.log('✅ WebSocket connected');
        wsReconnectAttempts = 0; // Reset reconnect counter on successful connection

        // Send keepalive pings to prevent browser from closing idle connections
        clearInterval(pingInterval);
        pingInterval = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 25000);

        if (isReconnect) {
          statusText.textContent = 'Reconnected!';
          showToast('Connection restored!');
        } else {
          statusText.textContent = isSender ? 'Share this code with receiver:' : 'Connected to room:';
        }
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleSignalingMessage(data);
      };

      ws.onerror = (error) => {
        console.error('❌ WebSocket error:', error);
      };

      ws.onclose = (event) => {
        console.log('WebSocket closed', event.code, event.reason);

        clearInterval(pingInterval);
        pingInterval = null;

        // Don't reconnect if close was intentional or max retries exceeded
        if (isIntentionalClose || wsReconnectAttempts >= 5) {
          if (wsReconnectAttempts >= 5) {
            showError('Connection lost. Please refresh the page.');
          }
          return;
        }

        // Attempt reconnection with exponential backoff
        wsReconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts - 1), 16000); // 1s, 2s, 4s, 8s, 16s

        console.log(`🔄 Reconnecting in ${delay/1000}s (attempt ${wsReconnectAttempts}/5)...`);
        statusText.textContent = `Reconnecting in ${delay/1000}s...`;
        showToast(`Connection lost. Reconnecting (attempt ${wsReconnectAttempts}/5)...`);

        wsReconnectTimeout = setTimeout(() => {
          console.log(`🔄 Attempting reconnect ${wsReconnectAttempts}/5`);
          connectWebSocket(room, true);
        }, delay);
      };
    }
    
    async function handleSignalingMessage(data) {
      console.log('📡 Signaling:', data.type);
      
      switch (data.type) {
        case 'connected':
          sessionId = data.sessionId;
          console.log('My session:', sessionId);
          break;
          
        case 'peer-joined':
          updateStatusBadge('connecting', 'Connecting...');
          statusText.textContent = 'Peer connected! Establishing connection...';
          showToast('Peer joined! Connecting...');

          if (isSender) {
            // Update button to gray/clickable state (allows skipping P2P)
            updateSendButton('connecting');
            // Start P2P connection with timeout
            await initiatePeerConnection();
          }
          break;
          
        case 'offer':
          await handleOffer(data);
          break;
          
        case 'answer':
          await handleAnswer(data);
          break;
          
        case 'ice-candidate':
          await handleIceCandidate(data);
          break;
          
        case 'fallback-link':
          // Receiver got fallback download link
          handleFallbackLink(data);
          break;

        case 'url-fallback':
          // Receiver got URL redirect link (fallback)
          handleUrlFallback(data);
          break;

        case 'text-fallback':
          // Receiver got plain text via cloud relay
          handleTextFallback(data);
          break;

        case 'peer-left':
          updateStatusBadge('waiting', 'Waiting for peer...');
          statusText.textContent = 'Peer disconnected';
          roomCodeEl.classList.remove('connected');
          sendBtn.disabled = true;
          showToast('Peer disconnected');
          break;

        case 'pong':
          // keepalive acknowledgement — no action needed
          break;
      }
    }
    
    async function initiatePeerConnection() {
      try {
        pc = new RTCPeerConnection(CONFIG);
        setupPeerConnectionHandlers();
        
        // Create data channel
        dataChannel = pc.createDataChannel('file-transfer', {
          ordered: true
        });
        setupDataChannel();
        
        // Create and send offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        ws.send(JSON.stringify({
          type: 'offer',
          offer: offer
        }));
        
        // Set timeout for P2P connection
        p2pTimeout = setTimeout(() => {
          if (!isP2PConnected) {
            console.log('☁️ Using Cloud Relay for this transfer');
            updateStatusBadge('relay', 'Cloud Relay Active');
            statusText.textContent = 'Using Cloud Relay for this transfer';
            showToast('Using Cloud Relay');
            updateSendButton('relay');
          }
        }, CONFIG.p2pTimeout);
        
      } catch (error) {
        console.error('❌ P2P initiation error:', error);
        handleP2PFailure();
      }
    }
    
    async function handleOffer(data) {
      try {
        pc = new RTCPeerConnection(CONFIG);
        setupPeerConnectionHandlers();
        
        // Set up data channel handler
        pc.ondatachannel = (event) => {
          dataChannel = event.channel;
          setupDataChannel();
        };
        
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        ws.send(JSON.stringify({
          type: 'answer',
          answer: answer,
          target: data.from
        }));
        
      } catch (error) {
        console.error('❌ Handle offer error:', error);
      }
    }
    
    async function handleAnswer(data) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      } catch (error) {
        console.error('❌ Handle answer error:', error);
      }
    }
    
    async function handleIceCandidate(data) {
      try {
        if (data.candidate && pc) {
          console.log('📥 Received ICE candidate:', data.candidate.type, data.candidate.candidate);
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          console.log('✅ ICE candidate added successfully');
        }
      } catch (error) {
        console.error('❌ ICE candidate error:', error);
      }
    }
    
    function setupPeerConnectionHandlers() {
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log('📤 Sending ICE candidate:', event.candidate.type, event.candidate.candidate);
          ws.send(JSON.stringify({
            type: 'ice-candidate',
            candidate: event.candidate
          }));
        } else {
          console.log('✅ ICE gathering complete');
        }
      };
      
      pc.onconnectionstatechange = () => {
        console.log('Connection state:', pc.connectionState);
        
        if (pc.connectionState === 'connected') {
          isP2PConnected = true;
          if (p2pTimeout) clearTimeout(p2pTimeout);
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          handleP2PFailure();
        }
      };
      
      pc.onicegatheringstatechange = () => {
        console.log('🧊 ICE gathering state:', pc.iceGatheringState);
      };
      
      pc.oniceconnectionstatechange = () => {
        console.log('🔌 ICE connection state:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          console.log('✅ ICE connection successful!');
        }
      };
    }
    
    function setupDataChannel() {
      dataChannel.binaryType = 'arraybuffer';
      dataChannel.bufferedAmountLowThreshold = 256 * 1024; // 256KB low-water mark
      
      dataChannel.onopen = () => {
        console.log('✅ Data channel open');
        isP2PConnected = true;
        updateStatusBadge('p2p', 'P2P Connected');
        statusText.textContent = 'Ready for P2P transfer!';

        if (p2pTimeout) clearTimeout(p2pTimeout);

        // The data channel is bidirectional: whichever side has staged
        // content ready (file, URL, or text) needs its Send button refreshed,
        // regardless of which side initiated the room (isSender).
        updateSendButton('p2p');

        if (urlInput.value.trim()) {
          sendUrlBtn.disabled = false;
          sendUrlBtn.textContent = 'Send URL (P2P)';
        }

        if (textInput.value.trim()) {
          sendTextBtn.disabled = false;
          sendTextBtn.textContent = 'Send Text (P2P)';
        }

        // Nearby: auto-send if triggered from Nearby tab
        if (nearbyAutoSendPending) {
          const type = nearbyAutoSendPending;
          nearbyAutoSendPending = null;
          setTimeout(() => {
            if (type === 'file') sendFile();
            else if (type === 'url') sendUrl();
            else if (type === 'text') sendText();
          }, 100);
        }
      };

      dataChannel.onmessage = (event) => {
        if (typeof event.data === 'string') {
          const data = JSON.parse(event.data);
          
          // Handle URL message
          if (data.type === 'url') {
            statusText.textContent = '🔗 Received URL!';
            const _tab = window.open(data.url, '_blank');
            if (!_tab) showPopupBlockedModal(data.url);
            return;
          }

          // Handle text message
          if (data.type === 'text') {
            showReceivedText(data.content);
            return;
          }
          
          // Handle batch-start announcement
          if (data.type === 'file-batch-start') {
            pendingFileCount = data.fileCount;
            receivedFileCount = 0;
            receivedFiles = [];
            return;
          }

          // Handle file metadata
          // Backward compat: old sender never sent file-batch-start
          if (pendingFileCount === 0) {
            pendingFileCount = 1;
            receivedFileCount = 0;
            receivedFiles = [];
          }

          fileName = data.fileName;
          totalSize = data.fileSize;

          if ((data.fileIndex ?? 0) === 0) {
            transferInProgress = true;
            acquireWakeLock();
          }

          statusText.textContent = pendingFileCount > 1
            ? `Receiving file ${(data.fileIndex ?? 0) + 1}/${pendingFileCount}...`
            : 'Receiving file via P2P...';
          fileInfo.style.display = 'block';
          fileNameEl.textContent = fileName;
          fileSizeEl.textContent = formatFileSize(totalSize);
          progress.style.display = 'block';

          receivedChunks = [];
          receivedSize = 0;
        } else {
          // File chunk
          receivedChunks.push(event.data);
          receivedSize += event.data.byteLength;
          
          const percent = (receivedSize / totalSize) * 100;
          progressFill.style.width = percent + '%';
          progressText.textContent = `Receiving... ${Math.round(percent)}%`;
          
          if (receivedSize >= totalSize) {
            downloadReceivedFile();
          }
        }
      };
      
      dataChannel.onerror = (error) => {
        console.error('❌ Data channel error:', error);
        handleP2PFailure();
      };
      
      dataChannel.onclose = () => {
        console.log('Data channel closed');
      };
    }
    
    function handleP2PFailure() {
      console.log('☁️ Switching to Cloud Relay');
      isP2PConnected = false;
      updateStatusBadge('relay', 'Cloud Relay Active');
      statusText.textContent = 'Connected via Cloud Relay';

      updateSendButton('relay');

      if (urlInput.value.trim()) {
        sendUrlBtn.disabled = false;
        sendUrlBtn.textContent = 'Send URL (via Cloud)';
      }

      if (textInput.value.trim()) {
        sendTextBtn.disabled = false;
        sendTextBtn.textContent = 'Send Text (via Cloud)';
      }
    }
    
    async function sendFile() {
      if (selectedFiles.length === 0) return;

      // Try P2P first if connected
      if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
        await sendFileP2P();
      } else {
        await sendFileFallback();
      }
    }
    
    async function sendFileP2P() {
      sendBtn.disabled = true;
      progress.style.display = 'block';
      transferInProgress = true;
      await acquireWakeLock();

      const totalBytes = selectedFiles.reduce((s, f) => s + f.size, 0);

      // Announce batch size to receiver
      dataChannel.send(JSON.stringify({
        type: 'file-batch-start',
        fileCount: selectedFiles.length
      }));

      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];

        // Send per-file metadata
        dataChannel.send(JSON.stringify({
          fileName: file.name,
          fileSize: file.size,
          fileIndex: i
        }));

        // Send chunks — wrapped in a Promise so we await completion before next file
        await new Promise((resolve) => {
          const reader = new FileReader();
          let offset = 0;
          const priorBytes = selectedFiles.slice(0, i).reduce((s, f) => s + f.size, 0);

          reader.onload = (e) => {
            dataChannel.send(e.target.result);
            offset += e.target.result.byteLength;

            const percent = ((priorBytes + offset) / totalBytes) * 100;
            progressFill.style.width = percent + '%';
            progressText.textContent = selectedFiles.length > 1
              ? `Sending ${i + 1}/${selectedFiles.length}: ${Math.round(percent)}%`
              : `Sending... ${Math.round(percent)}%`;

            if (offset < file.size) {
              // Backpressure: pause if the send buffer is above 1MB
              if (dataChannel.bufferedAmount > 1 * 1024 * 1024) {
                dataChannel.onbufferedamountlow = () => {
                  dataChannel.onbufferedamountlow = null;
                  readSlice(offset);
                };
              } else {
                readSlice(offset);
              }
            } else {
              resolve();
            }
          };

          function readSlice(o) {
            const slice = file.slice(o, o + CONFIG.chunkSize);
            reader.readAsArrayBuffer(slice);
          }

          readSlice(0);
        });
      }

      transferInProgress = false;
      releaseWakeLock();
      progressText.textContent = '✅ Transfer complete!';
      showToast(selectedFiles.length === 1 ? 'File sent successfully!' : `${selectedFiles.length} files sent!`);
      telehostPromo.style.display = 'block';
      setTimeout(() => {
        progress.style.display = 'none';
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Another File';
      }, 2000);
    }
    
    async function sendFileFallback() {
      try {
        // Validate all files up front
        for (const file of selectedFiles) {
          if (file.size > CONFIG.maxFileSize) {
            showError(`"${file.name}" is too large for Cloud Relay (max 20MB). Use P2P mode.`);
            sendBtn.disabled = false;
            return;
          }
        }

        sendBtn.disabled = true;
        progress.style.display = 'block';
        transferInProgress = true;
        await acquireWakeLock();

        for (let i = 0; i < selectedFiles.length; i++) {
          const file = selectedFiles[i];

          progressText.textContent = selectedFiles.length > 1
            ? `Verifying file ${i + 1}/${selectedFiles.length}...`
            : 'Verifying...';

          // Get Turnstile token for bot protection (one per file)
          let token;
          try {
            token = await getTurnstileToken();
          } catch (error) {
            console.error('Turnstile verification failed:', error);
            showError('Verification failed. Please try again.');
            sendBtn.disabled = false;
            progress.style.display = 'none';
            return;
          }

          progressText.textContent = selectedFiles.length > 1
            ? `Uploading ${i + 1}/${selectedFiles.length}: ${file.name}...`
            : 'Uploading to cloud...';

          const formData = new FormData();
          formData.append('file', file);
          formData.append('roomCode', roomCode);
          formData.append('fileName', file.name);
          formData.append('turnstileToken', token);

          const response = await fetch('/upload', {
            method: 'POST',
            body: formData
          });

          if (!response.ok) {
            const result = await response.json();
            if (response.status === 403) {
              throw new Error('Bot verification failed. Please refresh and try again.');
            }
            throw new Error(result.error || 'Upload failed');
          }

          const result = await response.json();
          if (!result.success) throw new Error(result.error || 'Upload failed');

          progressFill.style.width = `${((i + 1) / selectedFiles.length) * 100}%`;

          // Notify receiver about this file
          ws.send(JSON.stringify({
            type: 'fallback-link',
            fileId: result.fileId,
            downloadUrl: result.downloadUrl,
            fileName: file.name,
            fileIndex: i,
            fileCount: selectedFiles.length
          }));

          // Reset Turnstile widget so it can issue a fresh token for the next file
          if (window.turnstile && i < selectedFiles.length - 1) {
            window.turnstile.reset('#turnstileWidget');
          }
        }

        transferInProgress = false;
        releaseWakeLock();
        progressText.textContent = '✅ Uploaded! Links sent.';
        showToast(selectedFiles.length === 1 ? 'File uploaded! Link sent to receiver.' : `${selectedFiles.length} files uploaded!`);

        setTimeout(() => {
          progress.style.display = 'none';
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send Another File';
        }, 2000);

      } catch (error) {
        console.error('❌ Fallback upload error:', error);

        let errorMessage = error.message || 'Upload failed';
        if (error.message && error.message.includes('NetworkError')) {
          errorMessage = 'Network error. Please check your connection and try again.';
        } else if (error.message && error.message.includes('Bot verification')) {
          errorMessage = error.message;
        } else if (!error.message || error.message === 'Upload failed') {
          errorMessage = 'Upload failed. Please check your connection and try again.';
        }

        transferInProgress = false;
        releaseWakeLock();
        showError(errorMessage);
        sendBtn.disabled = false;
        progress.style.display = 'none';
      }
    }

    function handleFallbackLink(data) {
      const totalInBatch = data.fileCount ?? 1;
      if ((data.fileIndex ?? 0) === 0 || receivedFiles.length === 0) {
        receivedFiles = [];
        pendingFileCount = totalInBatch;
        receivedFileCount = 0;
      }

      receivedFiles.push({ fileName: data.fileName, url: data.downloadUrl });
      receivedFileCount++;

      if (receivedFileCount >= pendingFileCount) {
        statusText.textContent = receivedFiles.length === 1 ? 'File ready for download!' : 'All files ready!';
        showToast(receivedFiles.length === 1 ? 'File received via Cloud Relay!' : `${receivedFiles.length} files received!`);
        showReceiveSuccess('files', receivedFiles);
        pendingFileCount = 0;
        receivedFileCount = 0;
      } else {
        statusText.textContent = `Received ${receivedFileCount}/${pendingFileCount} files...`;
        showToast(`File ${receivedFileCount}/${pendingFileCount} received`);
      }
    }

    function handleUrlFallback(data) {
      statusText.textContent = '🔗 Received URL (via cloud)!';
      const _tab = window.open(data.redirectUrl, '_blank');
      if (!_tab) showPopupBlockedModal(data.redirectUrl);
    }

    function handleTextFallback(data) {
      showReceivedText(data.content);
      statusText.textContent = '📋 Text received via Cloud!';
      showToast('Text received!');
    }

    function showReceivedText(content) {
      statusText.textContent = '📋 Text received!';
      showToast('Text received!');
      showReceiveSuccess('text', { content });
    }

    async function sendText() {
      const content = textInput.value.trim();
      if (!content) {
        showError('Please enter some text');
        return;
      }

      sendTextBtn.disabled = true;

      if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify({ type: 'text', content }));
        statusText.textContent = '✅ Text sent via P2P!';
        showToast('Text sent!');
        setTimeout(() => {
          sendTextBtn.disabled = false;
          textInput.value = '';
        }, 2000);
      } else if (ws && ws.readyState === WebSocket.OPEN) {
        // Send directly via signaling relay — text is tiny, no R2 needed
        ws.send(JSON.stringify({ type: 'text-fallback', content }));
        statusText.textContent = '✅ Text sent via Cloud!';
        showToast('Text sent!');
        setTimeout(() => {
          sendTextBtn.disabled = false;
          textInput.value = '';
        }, 2000);
      } else {
        showError('Not connected. Please wait for a peer to join.');
        sendTextBtn.disabled = false;
      }
    }

    function downloadReceivedFile() {
      const blob = new Blob(receivedChunks);
      const url = URL.createObjectURL(blob);

      receivedFiles.push({ fileName, url });
      receivedFileCount++;
      receivedChunks = [];
      receivedSize = 0;

      if (receivedFileCount >= pendingFileCount) {
        transferInProgress = false;
        releaseWakeLock();
        statusText.textContent = receivedFiles.length === 1 ? '✅ File ready!' : '✅ All files ready!';
        showToast(receivedFiles.length === 1 ? 'File received!' : `${receivedFiles.length} files received!`);
        showReceiveSuccess('files', receivedFiles);
        pendingFileCount = 0;
        receivedFileCount = 0;
      } else {
        progressText.textContent = `File ${receivedFileCount}/${pendingFileCount} received, waiting for next...`;
      }
    }
    
    async function sendUrl() {
      const inputUrl = urlInput.value.trim();

      if (!inputUrl) {
        showError('Please enter a URL');
        return;
      }

      // Validate and prepare URL (auto-prepend https://)
      const result = validateAndPrepareURL(inputUrl);

      if (!result.valid) {
        showError('Invalid URL format. Please enter a valid URL (e.g., example.com or https://example.com)');
        return;
      }

      const url = result.url;

      // Update input with validated URL (with protocol)
      urlInput.value = url;

      sendUrlBtn.disabled = true;

      // Try P2P first if available
      if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
        // Send URL via DataChannel
        dataChannel.send(JSON.stringify({
          type: 'url',
          url: url
        }));

        statusText.textContent = '✅ URL sent via P2P!';
        showToast('URL shared successfully!');

        setTimeout(() => {
          sendUrlBtn.disabled = false;
          urlInput.value = '';
        }, 2000);
      } else {
        // Use R2 fallback
        try {
          progress.style.display = 'block';
          progressText.textContent = 'Verifying...';

          // Get Turnstile token for bot protection
          let token;
          try {
            token = await getTurnstileToken();
          } catch (error) {
            console.error('Turnstile verification failed:', error);
            showError('Verification failed. Please try again.');
            sendUrlBtn.disabled = false;
            progress.style.display = 'none';
            return;
          }

          progressText.textContent = 'Uploading URL...';

          const urlId = crypto.randomUUID();
          const timestamp = Date.now();

          // Upload URL as text to R2
          const response = await fetch('/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              urlId: urlId,
              url: url,
              roomCode: roomCode,
              timestamp: timestamp,
              turnstileToken: token
            })
          });

          if (!response.ok) {
            const result = await response.json();
            if (response.status === 403) {
              throw new Error('Bot verification failed. Please refresh and try again.');
            }
            throw new Error(result.error || 'URL upload failed');
          }

          const result = await response.json();

          if (result.success) {
            progressFill.style.width = '100%';
            progressText.textContent = '✅ URL uploaded!';

            // Send URL redirect link to receiver via signaling
            ws.send(JSON.stringify({
              type: 'url-fallback',
              urlId: urlId,
              redirectUrl: '/url-redirect/' + urlId
            }));

            showToast('URL shared via Cloud Relay!');

            setTimeout(() => {
              progress.style.display = 'none';
              sendUrlBtn.disabled = false;
              urlInput.value = '';
            }, 2000);
          } else {
            throw new Error(result.error || 'URL upload failed');
          }
        } catch (error) {
          console.error('❌ URL fallback error:', error);

          // Provide helpful error message based on error type
          let errorMessage = error.message || 'Failed to share URL';
          if (error.message && error.message.includes('NetworkError')) {
            errorMessage = 'Network error. Please check your connection and try again.';
          } else if (error.message && error.message.includes('Bot verification')) {
            errorMessage = error.message; // Use specific bot verification error
          } else if (error.message && error.message.includes('Invalid URL protocol')) {
            errorMessage = error.message; // Use specific protocol error
          } else if (!error.message || error.message === 'Failed to share URL') {
            errorMessage = 'Failed to share URL. Please check your connection and try again.';
          }

          showError(errorMessage);
          sendUrlBtn.disabled = false;
          progress.style.display = 'none';
        }
      }
    }
    
    function formatFileSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
      if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
      return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }
    
    function showToast(message) {
      toast.textContent = message;
      toast.classList.add('show');
      setTimeout(() => {
        toast.classList.remove('show');
      }, 3000);
    }

    let _pendingPopupUrl = null;

    function showPopupBlockedModal(url) {
      _pendingPopupUrl = url;
      popupOverlay.classList.add('active');
      popupModal.classList.add('active');
    }

    function hidePopupBlockedModal() {
      popupOverlay.classList.remove('active');
      popupModal.classList.remove('active');
      _pendingPopupUrl = null;
    }

    document.getElementById('popupRetry').addEventListener('click', () => {
      if (_pendingPopupUrl) window.open(_pendingPopupUrl, '_blank');
      hidePopupBlockedModal();
    });

    document.getElementById('popupCancel').addEventListener('click', hidePopupBlockedModal);
    document.getElementById('popupOverlay').addEventListener('click', hidePopupBlockedModal);
    
    function showError(message) {
      errorDiv.textContent = '❌ ' + message;
      errorDiv.style.display = 'block';
      setTimeout(() => {
        errorDiv.style.display = 'none';
      }, 5000);
    }
    
    // Event Listeners

    // Cookie Banner - Close button
    cookieBannerClose.addEventListener('click', dismissCookieBanner);

    // QR Modal - Click status to open (sender only)
    status.addEventListener('click', () => {
      if (isSender) {
        openQRModal();
      }
    });

    // QR Modal - Close button
    qrModalClose.addEventListener('click', closeQRModal);

    qrInlineWrapper.addEventListener('click', () => {
      const url = window.location.origin + window.location.pathname + '?room=' + roomCode;
      navigator.clipboard.writeText(url).then(() => showToast('Link copied!')).catch(() => showToast('Copy failed'));
    });

    // QR Modal - Click outside to close
    qrModal.addEventListener('click', (e) => {
      if (e.target === qrModal) {
        closeQRModal();
      }
    });

    // Escape key to close modals
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (qrModal.classList.contains('show')) closeQRModal();
        if (settingsModal.classList.contains('show')) closeSettingsModal();
        if (popupModal.classList.contains('active')) hidePopupBlockedModal();
      }
    });

    let lastSendTypeBtn = sendModeBtn;

    function activateSendRole() {
      sendRoleBtn.classList.add('active');
      receiveRoleBtn.classList.remove('active');
      sendTypeSelector.style.display = '';
      receiveSection.classList.remove('active');
      roleHint.textContent = 'Share your room code with the other device';
      status.style.display = '';
      if (qrInlineCodeEl.innerHTML) qrInlineWrapper.style.display = '';
      leftReceiveState.style.display = 'none';
    }

    // ── Nearby Tab Visibility + Switching ────────────────────────────────
    const nearbyRoleBtn = document.getElementById('nearbyRoleBtn');
    const nearbySection = document.getElementById('nearbySection');
    const nearbyIdentityName = document.getElementById('nearbyIdentityName');
    const nearbyIdentityInput = document.getElementById('nearbyIdentityInput');
    const nearbyPeerList = document.getElementById('nearbyPeerList');
    const nearbyEmpty = document.getElementById('nearbyEmpty');

    function nearbyUpdateTabVisibility() {
      nearbyRoleBtn.style.display = nearbyIsEnabled() ? '' : 'none';
      if (!nearbyIsEnabled() && nearbySection.classList.contains('active')) {
        switchToRole('send');
      }
    }

    function switchToRole(role) {
      [sendRoleBtn, receiveRoleBtn, nearbyRoleBtn].forEach(b => b.classList.remove('active'));
      nearbySection.classList.remove('active');

      // Restore send buttons whenever leaving Nearby mode
      sendBtn.style.display = '';
      sendUrlBtn.style.display = '';
      sendTextBtn.style.display = '';

      if (role === 'send') {
        lastSendTypeBtn.click();
      } else if (role === 'receive') {
        receiveRoleBtn.classList.add('active');
        sendTypeSelector.style.display = 'none';
        receiveSection.classList.add('active');
        sendSection.classList.remove('active');
        urlSection.classList.remove('active');
        textSection.classList.remove('active');
        roleHint.textContent = 'Enter the code shown on the other device';
        status.style.display = 'none';
        qrInlineWrapper.style.display = 'none';
        leftReceiveState.style.display = '';
        roomInput.focus();
      } else if (role === 'nearby') {
        nearbyRoleBtn.classList.add('active');
        nearbySection.classList.add('active');
        // Show the send-type selector and whichever sub-section was last active
        sendTypeSelector.style.display = '';
        receiveSection.classList.remove('active');
        // Re-activate the last send sub-section (sendSection/urlSection/textSection)
        // so drag-drop, paste, and file input all work inside Nearby
        lastSendTypeBtn.click(); // this also sets the right section active
        // But override the role-button state that lastSendTypeBtn.click() sets
        [sendRoleBtn, receiveRoleBtn, nearbyRoleBtn].forEach(b => b.classList.remove('active'));
        nearbyRoleBtn.classList.add('active');
        // Hide the "Waiting for receiver…" action buttons — tap-to-send replaces them
        sendBtn.style.display = 'none';
        sendUrlBtn.style.display = 'none';
        sendTextBtn.style.display = 'none';
        status.style.display = 'none';
        qrInlineWrapper.style.display = 'none';
        leftReceiveState.style.display = 'none';
        roleHint.textContent = 'Pick content above, then tap a device';
        nearbyIdentityName.textContent = nearbyGetIdentity().displayName;
      }
    }

    function nearbyIsActive() {
      return nearbySection.classList.contains('active');
    }

    nearbyRoleBtn.addEventListener('click', () => switchToRole('nearby'));
    sendRoleBtn.addEventListener('click', () => switchToRole('send'));
    receiveRoleBtn.addEventListener('click', () => switchToRole('receive'));

    // Init: show/hide Nearby tab based on saved setting
    nearbyUpdateTabVisibility();

    // ── Nearby: Inline Name Edit ──────────────────────────────────────────
    function nearbyBeginRename() {
      nearbyIdentityInput.value = nearbyGetIdentity().displayName;
      nearbyIdentityName.style.display = 'none';
      nearbyIdentityInput.style.display = '';
      nearbyIdentityInput.focus();
      nearbyIdentityInput.select();
    }

    function nearbyCommitRename() {
      const newName = nearbyIdentityInput.value.trim();
      if (newName) {
        nearbySetDisplayName(newName);
        if (nearbyWs && nearbyWs.readyState === WebSocket.OPEN) {
          nearbyWs.send(JSON.stringify({ type: 'update-name', displayName: newName }));
        }
        // Keep settings UI in sync
        const settingsDisplay = document.getElementById('nearbyNameDisplay');
        if (settingsDisplay) settingsDisplay.textContent = newName;
      }
      nearbyIdentityName.textContent = nearbyGetIdentity().displayName;
      nearbyIdentityInput.style.display = 'none';
      nearbyIdentityName.style.display = '';
    }

    nearbyIdentityName.addEventListener('click', nearbyBeginRename);
    nearbyIdentityInput.addEventListener('blur', nearbyCommitRename);
    nearbyIdentityInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') nearbyIdentityInput.blur();
      if (e.key === 'Escape') {
        nearbyIdentityInput.value = nearbyGetIdentity().displayName;
        nearbyIdentityInput.blur();
      }
    });
    // ─────────────────────────────────────────────────────────────────────

    // ── NearbyLobby WebSocket Client ──────────────────────────────────────
    let nearbyWs = null;
    let nearbyIntentionalClose = false;
    let nearbyPeers = []; // [{ deviceId, displayName }]

    function nearbyConnect() {
      if (!nearbyIsEnabled()) return;
      if (nearbyWs && nearbyWs.readyState <= WebSocket.OPEN) return;

      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      nearbyWs = new WebSocket(`${proto}://${location.host}/nearby`);

      nearbyWs.addEventListener('open', () => {
        console.log('[Nearby] Connected to lobby');
        const { deviceId, displayName } = nearbyGetIdentity();
        nearbyWs.send(JSON.stringify({ type: 'announce', deviceId, displayName }));
        nearbyStartPing();
      });

      nearbyWs.addEventListener('message', (e) => {
        try {
          const data = JSON.parse(e.data);
          nearbyHandleMessage(data);
        } catch (err) {
          console.error('[Nearby] Bad message:', err);
        }
      });

      nearbyWs.addEventListener('close', () => {
        console.log('[Nearby] Disconnected');
        nearbyPeers = [];
        nearbyRenderPeers();
        // Reconnect after 3s if still enabled and close was not intentional
        if (nearbyIsEnabled() && !nearbyIntentionalClose) setTimeout(nearbyConnect, 3000);
        nearbyIntentionalClose = false;
      });

      nearbyWs.addEventListener('error', () => {
        console.error('[Nearby] WebSocket error');
      });
    }

    function nearbyDisconnect() {
      if (nearbyWs) {
        nearbyIntentionalClose = true;
        nearbyWs.close();
        nearbyWs = null;
      }
      nearbyPeers = [];
      nearbyRenderPeers();
    }

    let nearbyPingInterval = null;
    function nearbyStartPing() {
      clearInterval(nearbyPingInterval);
      nearbyPingInterval = setInterval(() => {
        if (nearbyWs && nearbyWs.readyState === WebSocket.OPEN) {
          nearbyWs.send(JSON.stringify({ type: 'ping' }));
        }
      }, 25000);
    }

    // ── Tab Visibility Management ─────────────────────────────────────────────
    // Disconnect WebSockets after 60s hidden to avoid wasting Durable Object
    // invocations. Reconnect immediately when the tab becomes visible again.
    // P2P (WebRTC data channel) is unaffected — it is peer-to-peer.
    let visibilityHideTimer = null;

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        visibilityHideTimer = setTimeout(() => {
          visibilityHideTimer = null;
          if (transferInProgress) return;

          if (ws && ws.readyState <= WebSocket.OPEN) {
            ws.onclose = null;
            ws.onerror = null;
            ws.close();
          }

          nearbyDisconnect();
        }, 60_000);
      } else {
        if (visibilityHideTimer !== null) {
          clearTimeout(visibilityHideTimer);
          visibilityHideTimer = null;
        }

        if (roomCode && (!ws || ws.readyState > WebSocket.OPEN)) {
          connectWebSocket(roomCode, true);
        }

        if (nearbyIsEnabled() && (!nearbyWs || nearbyWs.readyState > WebSocket.OPEN)) {
          nearbyConnect();
        }

        if (transferInProgress) acquireWakeLock();
      }
    });
    // ─────────────────────────────────────────────────────────────────────────

    // Auto-connect on load if enabled
    if (nearbyIsEnabled()) nearbyConnect();
    // ─────────────────────────────────────────────────────────────────────

    // ── Nearby Peer Rendering ─────────────────────────────────────────────
    function nearbyRenderPeers() {
      nearbyPeerList.innerHTML = '';
      if (nearbyPeers.length === 0) {
        nearbyPeerList.appendChild(nearbyEmpty);
        return;
      }
      for (const peer of nearbyPeers) {
        const trusted = nearbyIsTrusted(peer.deviceId);
        const item = document.createElement('div');
        item.className = 'nearby-peer-item';
        item.dataset.deviceId = peer.deviceId;
        item.innerHTML = `
          <div>
            <span class="nearby-peer-name">${escapeHtml(peer.displayName)}</span>
            ${trusted ? '<span class="nearby-peer-trusted">✓ Trusted</span>' : ''}
          </div>
          <span class="nearby-peer-status">Tap to send</span>
        `;
        item.addEventListener('click', () => nearbyInitiateSend(peer));
        nearbyPeerList.appendChild(item);
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    // ── Nearby Message Handler ────────────────────────────────────────────
    function nearbyHandleMessage(data) {
      switch (data.type) {
        case 'connected':
          console.log('[Nearby] Session:', data.sessionId);
          break;

        case 'peer-list':
          nearbyPeers = data.peers;
          nearbyRenderPeers();
          break;

        case 'send-request':
          nearbyHandleIncomingRequest(data);
          break;

        case 'send-accepted':
          // Receiver accepted — join the room they created
          nearbySenderJoinRoom(data.roomCode);
          break;

        case 'send-declined':
          nearbyClosePendingRequest();
          showToast('Transfer declined');
          break;

        case 'pong':
          break;

        default:
          console.log('[Nearby] Unknown message:', data.type);
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    // ── Nearby: Sender Side ───────────────────────────────────────────────
    let nearbySendTargetDeviceId = null;
    let nearbyContentType = null; // 'file' | 'url' | 'text'
    let nearbyLastTransferPeer = null; // { deviceId, displayName }
    // (nearbySendFile removed — content lives in selectedFiles/urlInput/textInput)

    // Tap a device → check what content is ready and send it
    function nearbyInitiateSend(peer) {
      // Determine active content type and validate content exists
      let contentType, fileName, fileSize;

      if (sendSection.classList.contains('active')) {
        if (!selectedFiles.length) {
          showToast('Pick a file above first');
          return;
        }
        contentType = 'file';
        fileName = selectedFiles.length === 1
          ? selectedFiles[0].name
          : `${selectedFiles.length} files`;
        fileSize = selectedFiles.reduce((sum, f) => sum + f.size, 0);
      } else if (urlSection.classList.contains('active')) {
        if (!urlInput.value.trim()) {
          showToast('Enter a URL above first');
          return;
        }
        contentType = 'url';
        fileName = urlInput.value.trim();
        fileSize = 0;
      } else if (textSection.classList.contains('active')) {
        if (!textInput.value.trim()) {
          showToast('Enter some text above first');
          return;
        }
        contentType = 'text';
        fileName = 'Text snippet';
        fileSize = new Blob([textInput.value]).size;
      } else {
        showToast('Pick content above first');
        return;
      }

      nearbySendTargetDeviceId = peer.deviceId;
      nearbyContentType = contentType;

      // Update peer item to show "Waiting…"
      const item = nearbyPeerList.querySelector(`[data-device-id="${peer.deviceId}"]`);
      if (item) item.querySelector('.nearby-peer-status').textContent = 'Waiting…';

      nearbyWs.send(JSON.stringify({
        type: 'send-request',
        targetDeviceId: peer.deviceId,
        fileName,
        fileSize,
      }));
    }

    function nearbySenderJoinRoom(roomCode) {
      if (!nearbyContentType) return;
      const peer = nearbyPeers.find(p => p.deviceId === nearbySendTargetDeviceId);
      if (peer) nearbyLastTransferPeer = { deviceId: peer.deviceId, displayName: peer.displayName };
      const type = nearbyContentType;
      nearbySendTargetDeviceId = null;
      nearbyContentType = null;
      switchToRole('send');
      nearbyTriggerSend(roomCode, type);
    }

    function nearbyClosePendingRequest() {
      nearbySendTargetDeviceId = null;
      nearbyContentType = null;
      nearbyRenderPeers();
    }
    // ─────────────────────────────────────────────────────────────────────

    // ── Nearby: Receiver Side ─────────────────────────────────────────────
    const nearbyRequestModal = document.getElementById('nearbyRequestModal');
    const nearbyRequestFrom = document.getElementById('nearbyRequestFrom');
    const nearbyRequestFile = document.getElementById('nearbyRequestFile');
    const nearbyRequestSize = document.getElementById('nearbyRequestSize');
    const nearbyAcceptBtn = document.getElementById('nearbyAcceptBtn');
    const nearbyDeclineBtn = document.getElementById('nearbyDeclineBtn');

    let nearbyIncomingRequest = null; // { fromDeviceId, fromName, fileName, fileSize }

    function nearbyHandleIncomingRequest(data) {
      nearbyIncomingRequest = data;
      const trusted = nearbyIsTrusted(data.fromDeviceId);
      const autoDownload = localStorage.getItem('autoDownloadFiles') === 'true';

      if (trusted && autoDownload) {
        // Fully frictionless: auto-accept
        nearbyAcceptIncoming();
        return;
      }

      nearbyRequestFrom.textContent = `${data.fromName} wants to send you:`;
      nearbyRequestFile.textContent = data.fileName;
      nearbyRequestSize.textContent = formatFileSize(data.fileSize);
      nearbyRequestModal.style.display = 'flex';
    }

    function nearbyAcceptIncoming() {
      if (!nearbyIncomingRequest) return;
      const roomCode = generateRoomCode();
      const { fromDeviceId, fromName } = nearbyIncomingRequest;
      // Store peer for trust offer BEFORE clearing
      nearbyLastTransferPeer = { deviceId: fromDeviceId, displayName: fromName };
      nearbyRequestModal.style.display = 'none';
      nearbyWs.send(JSON.stringify({
        type: 'send-response',
        targetDeviceId: fromDeviceId,
        accepted: true,
        roomCode,
      }));
      nearbyReceiverJoinRoom(roomCode, nearbyIncomingRequest);
      nearbyIncomingRequest = null;
    }

    function nearbyDeclineIncoming() {
      if (!nearbyIncomingRequest) return;
      nearbyWs.send(JSON.stringify({
        type: 'send-response',
        targetDeviceId: nearbyIncomingRequest.fromDeviceId,
        accepted: false,
        roomCode: null,
      }));
      nearbyRequestModal.style.display = 'none';
      nearbyIncomingRequest = null;
    }

    nearbyAcceptBtn.addEventListener('click', nearbyAcceptIncoming);
    nearbyDeclineBtn.addEventListener('click', nearbyDeclineIncoming);
    // ─────────────────────────────────────────────────────────────────────

    // ── Nearby: Transfer Handoff ──────────────────────────────────────────
    let nearbyAutoSendPending = null; // null | 'file' | 'url' | 'text'

    function nearbyTriggerSend(roomCode, contentType) {
      // Content is already prepared in selectedFiles / urlInput / textInput
      // Close existing signaling connection and join as sender with the given room code
      isSender = true;
      if (ws) {
        isIntentionalClose = true;
        ws.close();
        isIntentionalClose = false;
      }
      roomCodeEl.textContent = roomCode;
      generateQRCode(roomCode);
      connectWebSocket(roomCode);
      status.classList.add('clickable');
      nearbyAutoSendPending = contentType;
    }

    function nearbyReceiverJoinRoom(roomCode) {
      // Switch to receive tab and auto-join the room
      switchToRole('receive');
      const ri = document.getElementById('roomInput');
      ri.value = roomCode;
      document.getElementById('joinBtn').click();
    }

    // ── Nearby: Post-Transfer Trust Offer ────────────────────────────────
    function nearbyOfferTrust(deviceId, displayName) {
      if (nearbyIsTrusted(deviceId)) return; // already trusted
      const toastEl = document.getElementById('toast');
      toastEl.innerHTML = `
        Trust <strong>${escapeHtml(displayName)}</strong>? Skip confirmation next time.
        <button id="nearbyTrustYes" style="margin-left:10px;background:#7c3aed;color:#fff;border:none;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:13px;">Trust</button>
      `;
      toastEl.style.display = 'flex';
      toastEl.style.alignItems = 'center';
      toastEl.classList.add('show');
      document.getElementById('nearbyTrustYes').addEventListener('click', () => {
        nearbyTrustDevice(deviceId, displayName);
        showToast(`${displayName} trusted!`);
      });
      setTimeout(() => toastEl.classList.remove('show'), 8000);
    }
    // ─────────────────────────────────────────────────────────────────────

    sendModeBtn.addEventListener('click', () => {
      if (!nearbyIsActive()) activateSendRole();
      lastSendTypeBtn = sendModeBtn;
      sendModeBtn.classList.add('active');
      urlModeBtn.classList.remove('active');
      textModeBtn.classList.remove('active');
      sendSection.classList.add('active');
      urlSection.classList.remove('active');
      textSection.classList.remove('active');
      if (nearbyIsActive()) { sendBtn.style.display = 'none'; }
    });

    urlModeBtn.addEventListener('click', () => {
      if (!nearbyIsActive()) activateSendRole();
      lastSendTypeBtn = urlModeBtn;
      urlModeBtn.classList.add('active');
      sendModeBtn.classList.remove('active');
      textModeBtn.classList.remove('active');
      urlSection.classList.add('active');
      sendSection.classList.remove('active');
      textSection.classList.remove('active');
      if (nearbyIsActive()) { sendUrlBtn.style.display = 'none'; }
    });

    textModeBtn.addEventListener('click', () => {
      if (!nearbyIsActive()) activateSendRole();
      lastSendTypeBtn = textModeBtn;
      textModeBtn.classList.add('active');
      sendModeBtn.classList.remove('active');
      urlModeBtn.classList.remove('active');
      textSection.classList.add('active');
      sendSection.classList.remove('active');
      urlSection.classList.remove('active');
      textInput.focus();
      if (nearbyIsActive()) { sendTextBtn.style.display = 'none'; }
    });
    
    // File selection - click
    uploadArea.addEventListener('click', () => fileInput.click());
    
    // Full-page drag overlay
    const dragOverlay = document.getElementById('dragOverlay');
    let dragCounter = 0;

    document.addEventListener('dragenter', (e) => {
      if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
        dragCounter++;
        if (receiveSuccessPanel.classList.contains('active')) {
          successResetBtn.click();
          sendRoleBtn.click();
        }
        dragOverlay.classList.add('active');
      }
    });

    document.addEventListener('dragleave', (e) => {
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        dragOverlay.classList.remove('active');
      }
    });

    document.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    dragOverlay.addEventListener('drop', (e) => {
      e.preventDefault();
      dragCounter = 0;
      dragOverlay.classList.remove('active');

      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        // Switch to send mode if not already there
        sendModeBtn.click();

        selectedFiles = [...selectedFiles, ...files];
        const dataTransfer = new DataTransfer();
        selectedFiles.forEach(f => dataTransfer.items.add(f));
        fileInput.files = dataTransfer.files;
        renderFileList();

        if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
          updateSendButton('p2p');
        } else if (ws && ws.readyState === WebSocket.OPEN) {
          updateSendButton('connecting');
        } else {
          updateSendButton('waiting');
        }

        showToast(files.length === 1
          ? ('Added: ' + files[0].name)
          : (files.length + ' files added'));
      }
    });

    // Drag and drop support (small upload area still works too)
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.style.borderColor = '#667eea';
      uploadArea.style.background = 'var(--upload-area-hover)';
    });

    uploadArea.addEventListener('dragleave', (e) => {
      e.preventDefault();
      uploadArea.style.borderColor = '';
      uploadArea.style.background = '';
    });

    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.style.borderColor = '';
      uploadArea.style.background = '';

      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        selectedFiles = [...selectedFiles, ...files];
        const dataTransfer = new DataTransfer();
        selectedFiles.forEach(f => dataTransfer.items.add(f));
        fileInput.files = dataTransfer.files;
        renderFileList();

        if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
          updateSendButton('p2p');
        } else if (ws && ws.readyState === WebSocket.OPEN) {
          updateSendButton('connecting');
        } else {
          updateSendButton('waiting');
        }

        showToast(files.length === 1
          ? ('Added: ' + files[0].name)
          : (files.length + ' files added'));
      }
    });
    
    fileInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files);
      if (files.length > 0) {
        selectedFiles = [...selectedFiles, ...files];
        renderFileList();

        if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
          updateSendButton('p2p');
        } else if (ws && ws.readyState === WebSocket.OPEN) {
          updateSendButton('connecting');
        } else {
          updateSendButton('waiting');
        }
      }
    });
    
    sendBtn.addEventListener('click', sendFile);

    // URL input handling - validate on input
    urlInput.addEventListener('input', () => {
      const inputValue = urlInput.value.trim();

      if (!inputValue) {
        sendUrlBtn.disabled = true;
        return;
      }

      // Enable button if there's text (validation happens on send)
      if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
        sendUrlBtn.disabled = false;
        sendUrlBtn.textContent = 'Send URL (P2P)';
      } else if (ws && ws.readyState === WebSocket.OPEN) {
        sendUrlBtn.disabled = false;
        sendUrlBtn.textContent = 'Send URL (via Cloud)';
      }
    });

    // Paste URL button
    pasteUrlBtn.addEventListener('click', pasteURLFromClipboard);

    sendUrlBtn.addEventListener('click', sendUrl);

    // Text mode listeners
    textInput.addEventListener('input', () => {
      const hasContent = textInput.value.trim().length > 0;
      if (!hasContent) {
        sendTextBtn.disabled = true;
        return;
      }
      if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
        sendTextBtn.disabled = false;
        sendTextBtn.textContent = 'Send Text (P2P)';
      } else if (ws && ws.readyState === WebSocket.OPEN) {
        sendTextBtn.disabled = false;
        sendTextBtn.textContent = 'Send Text (via Cloud)';
      }
    });

    pasteTextBtn.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!text) {
          showError('Clipboard is empty.');
          return;
        }
        textInput.value = text;
        textInput.dispatchEvent(new Event('input'));
        showToast('Pasted from clipboard!');
      } catch (e) {
        showError('Could not access clipboard. Please paste manually (Ctrl+V / Cmd+V).');
      }
    });

    clearTextBtn.addEventListener('click', () => {
      textInput.value = '';
      sendTextBtn.disabled = true;
    });


    sendTextBtn.addEventListener('click', sendText);

    joinBtn.addEventListener('click', () => {
      const code = roomInput.value.trim().replace(/D/g, '');
      if (code.length !== 6) {
        showError('Please enter a 6-digit room code');
        return;
      }

      isSender = false;
      roomCode = code;
      roomCodeEl.textContent = code;

      // Mark as intentional close to prevent reconnection
      if (ws) {
        isIntentionalClose = true;
        ws.close();
        isIntentionalClose = false;
      }

      connectWebSocket(code);
      statusText.textContent = 'Connecting to room...';

      // Receivers don't get clickable status
      status.classList.remove('clickable');

      activateReceiveJoined(code);
    });

    // Auto-join when 6th digit is typed
    roomInput.addEventListener('input', () => {
      const code = roomInput.value.replace(/D/g, '');
      if (code.length === 6 && localStorage.getItem('autoJoinRoom') !== 'false') {
        joinBtn.click();
      }
    });

    // Global paste handler: files → File tab, URLs → URL tab, text → Text tab
    document.addEventListener('paste', (e) => {
      // Let native paste work in inputs/textareas
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      const items = Array.from(e.clipboardData.items);
      const fileItems = items.filter(i => i.kind === 'file');

      if (fileItems.length > 0) {
        e.preventDefault();
        const files = fileItems.map(i => i.getAsFile()).filter(Boolean);
        if (files.length === 0) return;

        sendModeBtn.click();
        selectedFiles = [...selectedFiles, ...files];
        const dataTransfer = new DataTransfer();
        selectedFiles.forEach(f => dataTransfer.items.add(f));
        fileInput.files = dataTransfer.files;
        renderFileList();

        if (isP2PConnected && dataChannel && dataChannel.readyState === 'open') {
          updateSendButton('p2p');
        } else if (ws && ws.readyState === WebSocket.OPEN) {
          updateSendButton('connecting');
        } else {
          updateSendButton('waiting');
        }

        showToast(files.length === 1
          ? ('Added: ' + files[0].name)
          : (files.length + ' files added'));
        return;
      }

      const textItem = items.find(i => i.kind === 'string' && i.type === 'text/plain');
      if (textItem) {
        textItem.getAsString((text) => {
          text = text.trim();
          if (!text) return;
          const lc = text.toLowerCase();
          const isUrl = lc.startsWith('http://') || lc.startsWith('https://') || lc.startsWith('ftp://') ||
            (!text.includes(' ') && text.indexOf(String.fromCharCode(10)) === -1 && /[a-zA-Z0-9-]+.[a-zA-Z]{2,}/.test(text));
          if (isUrl) {
            urlModeBtn.click();
            urlInput.value = text;
            urlInput.dispatchEvent(new Event('input'));
            showToast('URL pasted!');
          } else {
            textModeBtn.click();
            textInput.value = text;
            textInput.dispatchEvent(new Event('input'));
            showToast('Text pasted!');
          }
        });
      }
    });
