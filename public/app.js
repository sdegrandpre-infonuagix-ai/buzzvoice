/* ═══════════════════════════════════════════════
   BuzzVoice — Core Audio Browser Engine
   ═══════════════════════════════════════════════ */
(function () {
  'use strict';

  // ─── State ───
  const state = {
    recording: false,
    processing: false,
    speaking: false,
    currentUrl: null,
    currentTitle: null,
    currentText: null,
    currentLinks: [],
    voice: 'eve',
    mediaRecorder: null,
    audioChunks: [],
    audioContext: null,
    analyser: null,
    animFrameId: null,
    currentAudio: null,
    ttsQueue: [],
    ttsPlaying: false,
    recordingSession: 0,
    pageWebmcpCompliant: false,   // is the currently loaded page WebMCP-compliant?
    pageWebmcpTools: [],          // declarative tools extracted from that page
    pageWebmcpSource: 'none',     // 'declarative' | 'imperative' | 'meta' | 'none'
    webmcpInteracted: false,      // has user already sent a WebMCP command on this page?
  };

  // ─── DOM Refs ───
  const $ = (id) => document.getElementById(id);
  const micBtn = $('mic-button');
  const micHint = $('mic-hint');
  const micIconRecord = micBtn.querySelector('.mic-button__icon:not(.mic-button__icon--stop)');
  const micIconStop = micBtn.querySelector('.mic-button__icon--stop');
  const canvas = $('waveform-canvas');
  const ctx = canvas.getContext('2d');
  const vizLabel = $('visualizer-label');
  const pageTitle = $('page-title');
  const pageUrl = $('page-url');
  const pageExcerpt = $('page-excerpt');
  const feed = $('transcript-feed');
  const linksSection = $('links-section');
  const linksList = $('links-list');
  const favsSection = $('favorites-section');
  const favsList = $('favorites-list');
  const voiceSelect = $('voice-selector');
  const statusText = $('status-text');
  const webmcpBadge = $('webmcp-badge');

  // ─── IndexedDB ───
  let db;
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('buzzvoice_db', 1);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('favorites')) {
          const store = d.createObjectStore('favorites', { keyPath: 'id', autoIncrement: true });
          store.createIndex('keywords', 'keywords', { multiEntry: true });
        }
      };
      req.onsuccess = (e) => { db = e.target.result; resolve(db); };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function getAllFavorites() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('favorites', 'readonly');
      const store = tx.objectStore('favorites');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function addFavorite(fav) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('favorites', 'readwrite');
      const req = tx.objectStore('favorites').add(fav);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteFavoriteById(id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('favorites', 'readwrite');
      const req = tx.objectStore('favorites').delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function findFavoriteByKeyword(keyword) {
    const all = await getAllFavorites();
    const kw = keyword.toLowerCase().trim();
    return all.find((f) => f.keywords.some((k) => k.toLowerCase().includes(kw)));
  }

  // ─── Canvas Setup ───
  function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width - 32;
    canvas.height = 100;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  function drawIdleWave(t) {
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, 'rgba(59,130,246,0.3)');
    grad.addColorStop(0.5, 'rgba(6,182,212,0.3)');
    grad.addColorStop(1, 'rgba(139,92,246,0.3)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const y = h / 2 + Math.sin(x * 0.02 + t * 0.002) * 8 + Math.sin(x * 0.01 + t * 0.001) * 5;
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function drawAnalyserWave(color1, color2) {
    if (!state.analyser) return;
    const bufLen = state.analyser.frequencyBinCount;
    const data = new Uint8Array(bufLen);
    state.analyser.getByteTimeDomainData(data);
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, color1);
    grad.addColorStop(1, color2);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    const sliceW = w / bufLen;
    let x = 0;
    for (let i = 0; i < bufLen; i++) {
      const v = data[i] / 128.0;
      const y = (v * h) / 2;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      x += sliceW;
    }
    ctx.lineTo(w, h / 2);
    ctx.stroke();
  }

  let idleTime = 0;
  function animLoop() {
    if (state.recording) {
      drawAnalyserWave('rgba(239,68,68,0.8)', 'rgba(239,68,68,0.4)');
    } else if (state.speaking) {
      drawAnalyserWave('rgba(6,182,212,0.8)', 'rgba(139,92,246,0.6)');
    } else {
      idleTime += 16;
      drawIdleWave(idleTime);
    }
    state.animFrameId = requestAnimationFrame(animLoop);
  }
  animLoop();

  // ─── Transcript Feed ───
  function addTranscript(type, html) {
    const labels = { user: 'You', system: 'BuzzVoice', error: 'Error', reading: 'Reading' };
    const div = document.createElement('div');
    div.className = `transcript-item transcript-item--${type}`;
    div.innerHTML = `<span class="transcript-badge">${labels[type] || type}</span><p>${html}</p>`;
    feed.appendChild(div);
    feed.scrollTop = feed.scrollHeight;
  }

  function setStatus(text) { statusText.textContent = text; }

  // ─── TTS ───
  async function speak(text) {
    if (!text || text.trim().length === 0) return;
    // Chunk long text
    const maxLen = 800;
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) { chunks.push(remaining); break; }
      let cut = remaining.lastIndexOf('.', maxLen);
      if (cut < maxLen * 0.3) cut = remaining.lastIndexOf(' ', maxLen);
      if (cut < 10) cut = maxLen;
      chunks.push(remaining.substring(0, cut + 1).trim());
      remaining = remaining.substring(cut + 1).trim();
    }
    for (const chunk of chunks) {
      await speakChunk(chunk);
    }
  }

  function speakChunk(text) {
    return new Promise(async (resolve) => {
      try {
        setStatus('Speaking...');
        state.speaking = true;
        vizLabel.textContent = 'Speaking';
        vizLabel.className = 'visualizer-label speaking';

        const resp = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice_id: state.voice }),
        });

        if (!resp.ok) {
          state.speaking = false;
          vizLabel.textContent = 'Idle';
          vizLabel.className = 'visualizer-label';
          resolve();
          return;
        }

        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        state.currentAudio = audio;

        // Connect to analyser for visualization
        try {
          if (!state.audioContext) state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
          const source = state.audioContext.createMediaElementSource(audio);
          state.analyser = state.audioContext.createAnalyser();
          state.analyser.fftSize = 2048;
          source.connect(state.analyser);
          state.analyser.connect(state.audioContext.destination);
        } catch (e) { /* analyser optional */ }

        audio.onended = () => {
          state.speaking = false;
          state.currentAudio = null;
          vizLabel.textContent = 'Idle';
          vizLabel.className = 'visualizer-label';
          setStatus('Ready');
          URL.revokeObjectURL(url);
          resolve();
        };
        audio.onerror = () => {
          state.speaking = false;
          state.currentAudio = null;
          resolve();
        };
        audio.play().catch(() => resolve());
      } catch (e) {
        state.speaking = false;
        resolve();
      }
    });
  }

  function stopSpeaking() {
    if (state.currentAudio) {
      state.currentAudio.pause();
      state.currentAudio.currentTime = 0;
      state.currentAudio = null;
    }
    state.speaking = false;
    vizLabel.textContent = 'Idle';
    vizLabel.className = 'visualizer-label';
    setStatus('Ready');
  }

  // ─── STT (Recording) ───
  async function startRecording() {
    // Stop any ongoing TTS
    if (state.speaking) stopSpeaking();
    // If already recording, stop that session first
    if (state.recording && state.mediaRecorder) {
      state.mediaRecorder.stop();
      state.recording = false;
    }
    // Bump session so any in-flight processAudio call discards its result
    const session = ++state.recordingSession;
    state.processing = false;
    resetMicState();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Guard: another recording may have started while awaiting permission
      if (session !== state.recordingSession) { stream.getTracks().forEach(t => t.stop()); return; }
      state.audioChunks = [];

      if (!state.audioContext) state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = state.audioContext.createMediaStreamSource(stream);
      state.analyser = state.audioContext.createAnalyser();
      state.analyser.fftSize = 2048;
      source.connect(state.analyser);

      state.mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      state.mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) state.audioChunks.push(e.data); };
      state.mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(state.audioChunks, { type: 'audio/webm' });
        await processAudio(blob, session);
      };

      state.mediaRecorder.start();
      state.recording = true;
      micBtn.classList.add('recording');
      micIconRecord.style.display = 'none';
      micIconStop.style.display = 'block';
      micHint.textContent = 'Listening… tap to stop';
      vizLabel.textContent = 'Recording';
      vizLabel.className = 'visualizer-label recording';
      setStatus('Listening...');
    } catch (e) {
      addTranscript('error', 'Microphone access denied. Please allow microphone permissions.');
      resetMicState();
    }
  }

  function stopRecording() {
    if (!state.recording || !state.mediaRecorder) return;
    state.mediaRecorder.stop();
    state.recording = false;
    micBtn.classList.remove('recording');
    micBtn.classList.add('processing');
    micIconRecord.style.display = 'block';
    micIconStop.style.display = 'none';
    micHint.textContent = 'Processing...';
    vizLabel.textContent = 'Processing';
    vizLabel.className = 'visualizer-label processing';
    setStatus('Transcribing...');
  }

  async function processAudio(blob, session) {
    state.processing = true;
    try {
      const formData = new FormData();
      formData.append('file', blob, 'recording.webm');

      const resp = await fetch('/api/stt', { method: 'POST', body: formData });

      // Discard result if a newer recording session has started
      if (session !== state.recordingSession) return;

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.details || `STT failed: ${resp.status}`);
      }

      const data = await resp.json();
      if (session !== state.recordingSession) return;  // check again after await

      const text = data.text?.trim();
      if (!text) {
        addTranscript('error', 'Could not understand. Please try again.');
        resetMicState();
        return;
      }

      addTranscript('user', text);
      await handleCommand(text);
    } catch (e) {
      if (session === state.recordingSession)
        addTranscript('error', `Speech recognition failed: ${e.message}`);
    }
    if (session === state.recordingSession) resetMicState();
  }

  function resetMicState() {
    state.processing = false;
    micBtn.classList.remove('processing');
    micHint.textContent = 'Tap to speak';
    vizLabel.textContent = 'Idle';
    vizLabel.className = 'visualizer-label';
    setStatus('Ready');
  }

  // ─── Command Parser ───
  async function handleCommand(raw) {
    const text = raw.toLowerCase().trim();

    // ─ WebMCP intercept: route FIRST post-load command on a compliant page ─
    // Only intercept if there are declarative tools (imperative-only pages handle
    // their own tool calls internally; we can still narrate for them).
    if (
      state.pageWebmcpCompliant &&
      !state.webmcpInteracted &&
      state.pageWebmcpTools.length > 0
    ) {
      await handleWebMCPCommand(raw);
      return;
    }

    // List WebMCP tools on the current page
    if (/^(?:list (?:of )?tools|what tools|show tools|available tools|page tools)$/i.test(text)) {
      if (!state.pageWebmcpCompliant || state.pageWebmcpTools.length === 0) {
        const msg = state.pageWebmcpCompliant
          ? 'This page is WebMCP-compliant but exposes no discoverable declarative tools.'
          : 'The current page is not WebMCP-compliant. No tools are available.';
        addTranscript('system', msg);
        await speak(msg);
      } else {
        const toolLines = state.pageWebmcpTools
          .map((t, i) => `${i + 1}. ${t.name}${t.description ? ': ' + t.description : ''}`)
          .join('<br>');
        addTranscript('system',
          `<strong>${state.pageWebmcpTools.length} WebMCP tool(s) on this page:</strong><br>${toolLines}`);
        const spoken = state.pageWebmcpTools
          .map((t, i) => `${i + 1}: ${t.name}. ${t.description || ''}`)
          .join('. ');
        await speak(`This page has ${state.pageWebmcpTools.length} WebMCP tools. ${spoken}`);
      }
      return;
    }

    // Navigate commands — try favorite keyword first, then treat as URL
    const navMatch = text.match(/^(?:go to|open|navigate to|visit|browse)\s+(.+)$/i);
    if (navMatch) {
      const arg = navMatch[1].trim();
      // Check favorites first (allows "go to news" to resolve a saved bookmark)
      const favByKw = await findFavoriteByKeyword(arg);
      if (favByKw) {
        addTranscript('system', `Opening favorite: <strong>${favByKw.title}</strong>`);
        await navigateTo(favByKw.url);
        return;
      }
      // Otherwise treat as URL
      let url = arg.replace(/\s+/g, '').replace(/dot\s*/gi, '.').replace(/slash/gi, '/');
      url = url.replace(/^(https?:\/\/)?\ s*/, '');
      if (!url.includes('.')) url += '.com';
      await navigateTo(url);
      return;
    }

    // Save favorite
    const saveMatch = text.match(/^(?:save|bookmark|save this|save this as|bookmark as|bookmark this as)\s+(?:as\s+)?(.+)$/i);
    if (saveMatch || text === 'save this' || text === 'bookmark this') {
      const keywords = saveMatch ? saveMatch[1].split(/[\s,]+/).filter(Boolean) : ['untitled'];
      await saveFavorite(keywords);
      return;
    }

    // Open favorite
    const favMatch = text.match(/^(?:open favorite|go to my|open my|find favorite|load favorite)\s+(.+)$/i);
    if (favMatch) {
      await openFavorite(favMatch[1].trim());
      return;
    }

    // List favorites
    if (text.includes('list favorite') || text.includes('show favorite') || text.includes('my favorite')) {
      await listFavorites();
      return;
    }

    // Delete favorite
    const delMatch = text.match(/^(?:delete favorite|remove favorite|delete bookmark)\s+(.+)$/i);
    if (delMatch) {
      await deleteFavorite(delMatch[1].trim());
      return;
    }

    // Read again
    if (text === 'read again' || text === 'repeat' || text === 'read' || text === 'read page') {
      await readCurrentPage();
      return;
    }

    // Stop
    if (text === 'stop' || text === 'stop reading' || text === 'silence' || text === 'quiet') {
      stopSpeaking();
      addTranscript('system', 'Stopped.');
      return;
    }

    // Click link
    const linkMatch = text.match(/^(?:click|follow|open)\s+link\s+(\d+)$/i);
    if (linkMatch) {
      await clickLink(parseInt(linkMatch[1]));
      return;
    }

    // Change voice
    const voiceMatch = text.match(/^(?:change voice|switch voice|use voice|voice)\s+(?:to\s+)?(\w+)$/i);
    if (voiceMatch) {
      changeVoice(voiceMatch[1].toLowerCase());
      return;
    }

    // Help
    if (text === 'help' || text.includes('what can you do') || text.includes('commands')) {
      const helpText = 'Available commands: Go to a website. Save as keyword. Open favorite keyword. List favorites. Delete favorite keyword. Read again. Stop. Click link number. Change voice to name. List tools, to hear WebMCP tools on the current page. And Help.';
      addTranscript('system', helpText);
      await speak(helpText);
      return;
    }

    // Unknown
    addTranscript('system', `I didn't recognize that command. Say <strong>"help"</strong> for a list of commands.`);
    await speak("I didn't recognize that command. Say help for a list of commands.");
  }

  // ─── WebMCP Badge ───
  function setWebMCPBadge(compliant, source) {
    if (compliant) {
      webmcpBadge.style.display = 'flex';
      webmcpBadge.title = `This page is WebMCP-compliant (${source})`;
    } else {
      webmcpBadge.style.display = 'none';
    }
  }

  // ─── WebMCP Tool Dispatch ───
  // Called for the first voice command after loading a compliant page.
  // Sends text + tool definitions to Grok, which returns the matching tool + params.
  async function handleWebMCPCommand(text) {
    setStatus('Routing to WebMCP…');
    addTranscript('system', `🤖 WebMCP: <em>${text}</em>`);

    try {
      const resp = await fetch('/api/grok-tool-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          tools: state.pageWebmcpTools,
          pageUrl: state.currentUrl,
          pageTitle: state.currentTitle,
        }),
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const result = await resp.json();

      if (result.reply) {
        addTranscript('system', result.reply);
        await speak(result.reply);
      }

      if (result.tool) {
        const toolDef = state.pageWebmcpTools.find((t) => t.name === result.tool);
        if (toolDef?.action) {
          try {
            const actionUrl = new URL(toolDef.action, state.currentUrl);
            const params    = result.params || {};
            const method    = (result.method || toolDef.method || 'GET').toUpperCase();
            if (method === 'POST') {
              addTranscript('system', `Submitting form (POST) to: <strong>${actionUrl.href}</strong>`);
              await navigateTo(actionUrl.href);
            } else {
              Object.entries(params).forEach(([k, v]) => {
                if (v !== null && v !== undefined && v !== '') actionUrl.searchParams.set(k, v);
              });
              addTranscript('system', `Submitting form (GET): <strong>${actionUrl.href}</strong>`);
              await navigateTo(actionUrl.href);
            }
          } catch { /* invalid URL — skip */ }
        } else {
          // No action URL — client-side JS form (e.g. French Bistro dialog).
          // Build a spoken summary of every field Grok filled in.
          const params = result.params || {};
          const fieldSummary = Object.entries(params)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ');
          const confirmation = result.reply ||
            `Reservation submitted with the following details: ${fieldSummary}`;
          addTranscript('system',
            `✅ <strong>Form filled via WebMCP</strong><br>${
              Object.entries(params).map(([k,v]) => `<em>${k}</em>: ${v}`).join('<br>')
            }`);
          await speak(confirmation);
        }
      }
    } catch (e) {
      addTranscript('error', `WebMCP dispatch failed: ${e.message}`);
      // Fall back to normal command handling on error
      await handleCommand(text);
    }

    state.webmcpInteracted = true;
  }

  // ─── Actions ───
  async function navigateTo(url) {
    if (!url.startsWith('http')) url = 'https://' + url;
    addTranscript('system', `Navigating to <strong>${url}</strong>...`);
    setStatus('Fetching page...');

    try {
      const resp = await fetch('/api/fetch-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }

      const data = await resp.json();
      state.currentUrl = url;
      state.currentTitle = data.title || url;
      state.currentText = data.text;
      state.currentLinks = data.links || [];

      // Update UI
      pageTitle.textContent = state.currentTitle;
      pageUrl.textContent = url;
      if (data.excerpt) {
        pageExcerpt.textContent = data.excerpt;
        pageExcerpt.classList.add('visible');
      }

      // Show links
      if (state.currentLinks.length > 0) {
        linksList.innerHTML = '';
        state.currentLinks.forEach((link) => {
          const li = document.createElement('li');
          li.textContent = link.text;
          li.title = link.url;
          li.addEventListener('click', () => navigateTo(link.url));
          linksList.appendChild(li);
        });
        linksSection.style.display = '';
      } else {
        linksSection.style.display = 'none';
      }

      // Update WebMCP state
      state.pageWebmcpCompliant = data.webmcp?.compliant || false;
      state.pageWebmcpTools = data.webmcp?.tools || [];
      state.pageWebmcpSource = data.webmcp?.source || 'none';
      state.webmcpInteracted = false;
      setWebMCPBadge(state.pageWebmcpCompliant, state.pageWebmcpSource);

      if (state.pageWebmcpCompliant) {
        addTranscript('system',
          `✅ This page is <strong>WebMCP-compliant</strong> (${state.pageWebmcpSource})${
            state.pageWebmcpTools.length ? ` — ${state.pageWebmcpTools.length} tool(s) available` : ''
          }. Your next voice command will be routed through WebMCP.`);
      }

      // Speak the content
      const summary = data.text.length > 1500
        ? data.text.substring(0, 1500) + '... End of summary. Say read again for more.'
        : data.text;
      const intro = `Page loaded: ${state.currentTitle}. `;
      addTranscript('reading', `<strong>${state.currentTitle}</strong><br>${data.excerpt || ''}`);
      await speak(intro + summary);
    } catch (e) {
      addTranscript('error', `Failed to load page: ${e.message}`);
      await speak(`Sorry, I couldn't load that page. ${e.message}`);
    }
  }

  async function readCurrentPage() {
    if (!state.currentText) {
      addTranscript('system', 'No page loaded. Say "go to" followed by a URL.');
      await speak('No page is currently loaded. Say go to followed by a website name.');
      return;
    }
    addTranscript('reading', `Re-reading: <strong>${state.currentTitle}</strong>`);
    await speak(state.currentText.substring(0, 3000));
  }

  async function saveFavorite(keywords) {
    if (!state.currentUrl) {
      addTranscript('system', 'No page loaded to save.');
      await speak('There is no page loaded to save as a favorite.');
      return;
    }
    const fav = {
      url: state.currentUrl,
      title: state.currentTitle || state.currentUrl,
      keywords: keywords.map((k) => k.toLowerCase()),
      createdAt: new Date().toISOString(),
    };
    await addFavorite(fav);
    addTranscript('system', `Saved <strong>${fav.title}</strong> with keywords: ${fav.keywords.join(', ')}`);
    await speak(`Saved ${fav.title} as a favorite with keywords: ${fav.keywords.join(', ')}`);
    renderFavorites();
  }

  async function openFavorite(keyword) {
    const fav = await findFavoriteByKeyword(keyword);
    if (!fav) {
      addTranscript('system', `No favorite found for "${keyword}".`);
      await speak(`I couldn't find a favorite matching ${keyword}.`);
      return;
    }
    addTranscript('system', `Opening favorite: <strong>${fav.title}</strong>`);
    await navigateTo(fav.url);
  }

  async function listFavorites() {
    const favs = await getAllFavorites();
    if (favs.length === 0) {
      addTranscript('system', 'You have no saved favorites.');
      await speak('You have no saved favorites yet.');
      return;
    }
    const list = favs.map((f, i) => `${i + 1}. ${f.title}, keywords: ${f.keywords.join(', ')}`).join('. ');
    addTranscript('system', `<strong>${favs.length} favorites:</strong><br>${favs.map((f) => `• ${f.title} (${f.keywords.join(', ')})`).join('<br>')}`);
    await speak(`You have ${favs.length} favorites. ${list}`);
  }

  async function deleteFavorite(keyword) {
    const fav = await findFavoriteByKeyword(keyword);
    if (!fav) {
      addTranscript('system', `No favorite found for "${keyword}".`);
      await speak(`No favorite found matching ${keyword}.`);
      return;
    }
    await deleteFavoriteById(fav.id);
    addTranscript('system', `Deleted favorite: <strong>${fav.title}</strong>`);
    await speak(`Deleted favorite: ${fav.title}`);
    renderFavorites();
  }

  async function clickLink(num) {
    const link = state.currentLinks.find((l) => l.index === num);
    if (!link) {
      addTranscript('system', `Link ${num} not found.`);
      await speak(`Link number ${num} was not found on this page.`);
      return;
    }
    addTranscript('system', `Following link ${num}: <strong>${link.text}</strong>`);
    await navigateTo(link.url);
  }

  function changeVoice(name) {
    const valid = ['eve', 'ara', 'leo', 'rex', 'sal'];
    if (!valid.includes(name)) {
      addTranscript('system', `Unknown voice "${name}". Available: ${valid.join(', ')}`);
      return;
    }
    state.voice = name;
    voiceSelect.value = name;
    addTranscript('system', `Voice changed to <strong>${name}</strong>`);
    speak(`Voice changed to ${name}.`);
  }

  // ─── Favorites UI ───
  async function renderFavorites() {
    const favs = await getAllFavorites();
    if (favs.length === 0) {
      favsList.innerHTML = '<p class="favorites-empty">No favorites yet. Say <strong>"Save this as [keyword]"</strong> to bookmark a page.</p>';
      return;
    }
    favsList.innerHTML = '';
    favs.forEach((fav) => {
      const div = document.createElement('div');
      div.className = 'favorite-item';
      div.innerHTML = `
        <div class="favorite-item__info">
          <div class="favorite-item__title">${fav.title}</div>
          <div class="favorite-item__keywords">${fav.keywords.map((k) => `<span class="favorite-keyword">${k}</span>`).join('')}</div>
          <div class="favorite-item__url">${fav.url}</div>
        </div>
        <button class="favorite-item__delete" title="Delete" aria-label="Delete favorite">✕</button>
      `;
      div.addEventListener('click', (e) => {
        if (!e.target.closest('.favorite-item__delete')) navigateTo(fav.url);
      });
      div.querySelector('.favorite-item__delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteFavoriteById(fav.id);
        renderFavorites();
      });
      favsList.appendChild(div);
    });
  }

  // ─── Event Listeners ───
  micBtn.addEventListener('click', () => {
    if (state.recording) stopRecording();   // finish current recording → submit
    else startRecording();                  // start fresh (handles TTS/processing internally)
  });

  voiceSelect.addEventListener('change', (e) => {
    state.voice = e.target.value;
    addTranscript('system', `Voice changed to <strong>${e.target.value}</strong>`);
  });

  // Keyboard shortcut: Space to toggle recording
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target === document.body) {
      e.preventDefault();
      micBtn.click();
    }
  });

  // ─── WebMCP Handler Registration ───
  if (window.__webmcp) {
    window.__webmcp.registerHandler('navigate', async (p) => { await navigateTo(p.url); return { success: true }; });
    window.__webmcp.registerHandler('readPageContent', async () => { await readCurrentPage(); return { success: true }; });
    window.__webmcp.registerHandler('saveFavorite', async (p) => { await saveFavorite(p.keywords); return { success: true }; });
    window.__webmcp.registerHandler('openFavorite', async (p) => { await openFavorite(p.keyword); return { success: true }; });
    window.__webmcp.registerHandler('listFavorites', async () => { const f = await getAllFavorites(); await listFavorites(); return { favorites: f }; });
    window.__webmcp.registerHandler('deleteFavorite', async (p) => { await deleteFavorite(p.keyword); return { success: true }; });
    window.__webmcp.registerHandler('changeVoice', async (p) => { changeVoice(p.voice); return { success: true }; });
    window.__webmcp.registerHandler('stopSpeaking', async () => { stopSpeaking(); return { success: true }; });
    window.__webmcp.registerHandler('clickLink', async (p) => { await clickLink(p.linkNumber); return { success: true }; });
  }

  // ─── Init ───
  async function init() {
    await openDB();
    await renderFavorites();

    // Manual add-favorite form
    const form = $('add-favorite-form');
    const urlInput = $('fav-url-input');
    const kwInput = $('fav-keyword-input');
    const errEl = $('add-fav-error');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.style.display = 'none';
      let url = urlInput.value.trim();
      const kwRaw = kwInput.value.trim();
      if (!url || !kwRaw) return;
      if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
      const keywords = kwRaw.split(/[\s,]+/).map(k => k.toLowerCase()).filter(Boolean);
      // Prevent duplicate keywords
      const existing = await findFavoriteByKeyword(keywords[0]);
      if (existing) {
        errEl.textContent = `Keyword "${keywords[0]}" already used by "${existing.title}".`;
        errEl.style.display = 'block';
        return;
      }
      await addFavorite({ url, title: url, keywords, createdAt: new Date().toISOString() });
      urlInput.value = '';
      kwInput.value = '';
      addTranscript('system', `Bookmarked <strong>${url}</strong> as <em>${keywords.join(', ')}</em>`);
      renderFavorites();
    });

    addTranscript('system', 'BuzzVoice is ready. Tap the microphone or press <strong>Space</strong> to speak.');
    setStatus('Ready');
  }

  init();
})();
