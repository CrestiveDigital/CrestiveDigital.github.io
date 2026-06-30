import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Play, Pause, Square, Plus, Trash2, BookOpen, ChevronRight, ChevronDown,
  X, StickyNote, Link2, GraduationCap, ClipboardList, Volume2, Gauge,
  Folder, FolderOpen, FileText, Highlighter, Clock, Check, ArrowLeft, Edit3, Upload, Download,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Persistence helpers (window.storage — persists across sessions)    */
/* ------------------------------------------------------------------ */
const META_KEY = "study.meta.v2";
const readingKey = (id) => `study.reading.${id}`;

// Use Claude's persistent window.storage when present (live preview);
// otherwise fall back to the browser's localStorage so the same build works
// when self-hosted (GitHub Pages, etc.). localStorage is only touched when
// window.storage is absent, so it never runs inside the Claude artifact sandbox.
const claudeStore =
  typeof window !== "undefined" && window.storage && typeof window.storage.get === "function"
    ? window.storage
    : null;

async function loadKey(key, fallback) {
  try {
    if (claudeStore) {
      const r = await claudeStore.get(key);
      if (!r) return fallback;
      return JSON.parse(r.value);
    }
    const v = localStorage.getItem(key);
    if (v == null) return fallback;
    return JSON.parse(v);
  } catch (e) {
    return fallback;
  }
}
async function saveKey(key, obj) {
  try {
    const s = JSON.stringify(obj);
    if (claudeStore) await claudeStore.set(key, s);
    else localStorage.setItem(key, s);
  } catch (e) {
    console.error("save failed", key, e);
  }
}
async function deleteKey(key) {
  try {
    if (claudeStore) await claudeStore.delete(key);
    else localStorage.removeItem(key);
  } catch (e) {}
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const CLASS_COLORS = ["#E89B3C", "#2BA6A4", "#8A7BE6", "#D9637B", "#5B9BD5", "#6FB36B"];

/* ------------------------------------------------------------------ */
/*  Text tokenizing + chunking                                         */
/* ------------------------------------------------------------------ */
function tokenize(text) {
  // Split into words + whitespace, each part keeps its global char range.
  const parts = [];
  const split = text.split(/(\s+)/);
  let pos = 0;
  for (const s of split) {
    if (s.length === 0) continue;
    const isWord = !/^\s+$/.test(s);
    parts.push({ text: s, start: pos, end: pos + s.length, isWord });
    pos += s.length;
  }
  return parts;
}

function buildChunks(text) {
  // Small chunks (<= ~220 chars) broken at sentence ends / spaces, with global offsets.
  const result = [];
  const MAX = 220;
  const n = text.length;
  let i = 0;
  while (i < n) {
    let end = Math.min(i + MAX, n);
    if (end < n) {
      let bp = -1;
      for (let j = i + 40; j < end; j++) {
        const c = text[j];
        if (c === "." || c === "!" || c === "?" || c === "\n") bp = j + 1;
      }
      if (bp === -1) {
        const sp = text.lastIndexOf(" ", end);
        if (sp > i + 40) end = sp + 1;
      } else {
        end = bp;
      }
    }
    const seg = text.slice(i, end);
    if (seg.trim().length > 0) result.push({ text: seg, start: i });
    i = end;
  }
  return result;
}

// binary search: last word-part starting at/before char
function wordIndexForChar(wordStarts, char) {
  let lo = 0, hi = wordStarts.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (wordStarts[mid].start <= char) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */
export default function StudyReader() {
  const [hydrated, setHydrated] = useState(false);
  const [meta, setMeta] = useState({
    classes: [],
    assignments: [],
    links: [],
    readingIndex: [],
    settings: { rate: 0.9, voiceURI: "" },
  });

  const [view, setView] = useState("reader"); // 'reader' | 'assignments'
  const [activeId, setActiveId] = useState(null);
  const [reading, setReading] = useState(null); // full reading object
  const [expanded, setExpanded] = useState({}); // classId -> bool

  const [voices, setVoices] = useState([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [currentChar, setCurrentChar] = useState(-1);

  const [sel, setSel] = useState(null); // {start,end,snippet}
  const [compose, setCompose] = useState(null); // {type,start,end,snippet,body,assignmentId}
  const [panelTab, setPanelTab] = useState("notes");

  // modals
  const [modal, setModal] = useState(null); // {type:...}

  const readingScrollRef = useRef(null);
  const sessionRef = useRef(0);
  const currentChunkRef = useRef(0);
  const rateRef = useRef(0.9);
  const voiceRef = useRef(null);
  const chunksRef = useRef([]);
  const flashRef = useRef(null);
  const importFileRef = useRef(null);

  const ttsSupported = typeof window !== "undefined" && "speechSynthesis" in window;

  /* ---------- hydrate ---------- */
  useEffect(() => {
    (async () => {
      const m = await loadKey(META_KEY, null);
      if (m) {
        setMeta((prev) => ({ ...prev, ...m, settings: { ...prev.settings, ...(m.settings || {}) } }));
        rateRef.current = (m.settings && m.settings.rate) || 0.9;
        if (m.readingIndex && m.readingIndex.length) setActiveId(m.readingIndex[m.readingIndex.length - 1].id);
        const exp = {};
        (m.classes || []).forEach((c) => (exp[c.id] = true));
        setExpanded(exp);
      }
      setHydrated(true);
    })();
  }, []);

  /* ---------- persist meta ---------- */
  useEffect(() => {
    if (!hydrated) return;
    saveKey(META_KEY, meta);
  }, [meta, hydrated]);

  /* ---------- load active reading ---------- */
  useEffect(() => {
    stopPlayback();
    setSel(null);
    setCompose(null);
    if (!activeId) {
      setReading(null);
      return;
    }
    (async () => {
      const r = await loadKey(readingKey(activeId), null);
      setReading(r);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  /* ---------- persist reading (debounced) ---------- */
  const readingSaveRef = useRef(null);
  useEffect(() => {
    if (!hydrated || !reading) return;
    clearTimeout(readingSaveRef.current);
    readingSaveRef.current = setTimeout(() => saveKey(readingKey(reading.id), reading), 350);
  }, [reading, hydrated]);

  /* ---------- voices ---------- */
  useEffect(() => {
    if (!ttsSupported) return;
    const load = () => {
      const vs = window.speechSynthesis.getVoices();
      if (vs.length) setVoices(vs);
    };
    load();
    window.speechSynthesis.onvoiceschanged = load;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, [ttsSupported]);

  const resolveVoice = useCallback(
    (uri) => voices.find((x) => x.voiceURI === uri) || voices.find((x) => x.default) || voices[0] || null,
    [voices]
  );

  useEffect(() => {
    voiceRef.current = resolveVoice(meta.settings.voiceURI);
  }, [voices, meta.settings.voiceURI, resolveVoice]);

  /* ---------- derived text data ---------- */
  const parts = useMemo(() => (reading ? tokenize(reading.text) : []), [reading]);
  const wordStarts = useMemo(
    () => parts.map((p, i) => ({ pi: i, start: p.start })).filter((_, i) => parts[i].isWord),
    [parts]
  );
  const chunks = useMemo(() => (reading ? buildChunks(reading.text) : []), [reading]);
  useEffect(() => {
    chunksRef.current = chunks;
  }, [chunks]);

  const currentWordPi = useMemo(() => {
    if (currentChar < 0 || !wordStarts.length) return -1;
    const idx = wordIndexForChar(wordStarts, currentChar);
    return idx >= 0 ? wordStarts[idx].pi : -1;
  }, [currentChar, wordStarts]);

  /* ---------- auto-scroll to current word ---------- */
  useEffect(() => {
    if (currentWordPi < 0) return;
    const el = readingScrollRef.current?.querySelector(`[data-pi="${currentWordPi}"]`);
    const cont = readingScrollRef.current;
    if (!el || !cont) return;
    const er = el.getBoundingClientRect();
    const cr = cont.getBoundingClientRect();
    if (er.top < cr.top + 60 || er.bottom > cr.bottom - 60) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [currentWordPi]);

  /* ---------- playback engine ---------- */
  const startPlayback = useCallback(
    (fromChunk = 0, fromChar = null) => {
      if (!ttsSupported) return;
      // Invalidate any in-flight utterance's callbacks BEFORE cancelling, so the
      // cancelled utterance's onend/onerror can't advance playback or move the highlight.
      const session = ++sessionRef.current;
      const wasSpeaking = window.speechSynthesis.speaking || window.speechSynthesis.pending;
      window.speechSynthesis.cancel();
      setIsPlaying(true);
      setIsPaused(false);
      // Pin the highlight to where we're resuming so it never flickers/disappears
      // during the cancel→speak gap (and stays put even for voices without word events).
      if (fromChar != null && fromChar >= 0) setCurrentChar(fromChar);
      // speak chunk `ci`, optionally starting `localStart` chars into it
      const speak = (ci, localStart = 0) => {
        if (session !== sessionRef.current) return;
        const cks = chunksRef.current;
        if (ci >= cks.length) {
          setIsPlaying(false);
          setIsPaused(false);
          setCurrentChar(-1);
          return;
        }
        currentChunkRef.current = ci;
        const chunk = cks[ci];
        const offset = localStart > 0 ? localStart : 0;
        const textToSpeak = offset > 0 ? chunk.text.slice(offset) : chunk.text;
        if (!textToSpeak.trim()) {
          speak(ci + 1, 0);
          return;
        }
        const u = new SpeechSynthesisUtterance(textToSpeak);
        u.rate = rateRef.current;
        if (voiceRef.current) u.voice = voiceRef.current;
        u.onboundary = (e) => {
          if (session !== sessionRef.current) return;
          setCurrentChar(chunk.start + offset + (e.charIndex || 0));
        };
        u.onend = () => {
          if (session !== sessionRef.current) return;
          speak(ci + 1, 0);
        };
        u.onerror = () => {
          if (session !== sessionRef.current) return;
          speak(ci + 1, 0);
        };
        window.speechSynthesis.speak(u);
      };
      const cks = chunksRef.current;
      const localStart = fromChar != null && cks[fromChunk] ? Math.max(0, fromChar - cks[fromChunk].start) : 0;
      const begin = () => {
        if (session !== sessionRef.current) return;
        speak(fromChunk, localStart);
      };
      // Chrome drops a speak() issued immediately after cancel(); if something was
      // playing, give the queue a beat to flush before starting the new voice.
      if (wasSpeaking) setTimeout(begin, 90);
      else begin();
    },
    [ttsSupported]
  );

  function chunkIndexForChar(char) {
    const cks = chunksRef.current;
    let ci = 0;
    for (let k = 0; k < cks.length; k++) {
      if (cks[k].start <= char) ci = k;
      else break;
    }
    return ci;
  }

  function stopPlayback() {
    sessionRef.current++;
    if (ttsSupported) window.speechSynthesis.cancel();
    setIsPlaying(false);
    setIsPaused(false);
    setCurrentChar(-1);
  }

  function togglePlay() {
    if (!reading || !reading.text.trim()) return;
    if (isPlaying && !isPaused) {
      window.speechSynthesis.pause();
      setIsPaused(true);
    } else if (isPlaying && isPaused) {
      window.speechSynthesis.resume();
      setIsPaused(false);
    } else {
      startPlayback(0);
    }
  }

  function playFromChar(char) {
    setCurrentChar(char);
    startPlayback(chunkIndexForChar(char), char);
  }

  // Update the rate while dragging (cheap, no playback restart).
  function changeRateValue(r) {
    rateRef.current = r;
    setMeta((m) => ({ ...m, settings: { ...m.settings, rate: r } }));
  }

  // Apply the new rate once the slider is released, resuming from the
  // current word rather than restarting the sentence.
  function commitRate() {
    if (isPlaying && !isPaused) {
      const char = currentChar >= 0 ? currentChar : chunksRef.current[currentChunkRef.current]?.start || 0;
      startPlayback(chunkIndexForChar(char), char);
    }
  }

  // Switch voice/language live, resuming from the current word.
  function changeVoice(uri) {
    voiceRef.current = resolveVoice(uri); // set synchronously so resume uses it
    setMeta((m) => ({ ...m, settings: { ...m.settings, voiceURI: uri } }));
    if (isPlaying && !isPaused) {
      const char = currentChar >= 0 ? currentChar : chunksRef.current[currentChunkRef.current]?.start || 0;
      startPlayback(chunkIndexForChar(char), char);
    }
  }

  /* ---------- keyboard: space toggles play ---------- */
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;
      if (e.code === "Space" && view === "reader" && reading) {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /* ---------- selection handling ---------- */
  function onReadingMouseUp(e) {
    const s = window.getSelection();
    const cont = readingScrollRef.current;
    if (!s || s.rangeCount === 0 || !cont) return;
    if (s.isCollapsed) {
      // plain click on a word -> play from there
      const span = e.target.closest("[data-start]");
      if (span && span.dataset.word === "1" && !isPlaying) {
        playFromChar(parseInt(span.dataset.start, 10));
      }
      setSel(null);
      return;
    }
    const range = s.getRangeAt(0);
    if (!cont.contains(range.startContainer) || !cont.contains(range.endContainer)) return;
    const ss = range.startContainer.parentElement?.closest("[data-start]");
    const es = range.endContainer.parentElement?.closest("[data-start]");
    if (!ss || !es) return;
    let start = parseInt(ss.dataset.start, 10) + range.startOffset;
    let end = parseInt(es.dataset.start, 10) + range.endOffset;
    if (start > end) [start, end] = [end, start];
    if (end - start < 1) return;
    const snippet = reading.text.slice(start, end);
    setSel({ start, end, snippet });
    setCompose(null);
  }

  function scrollToChar(char) {
    const idx = wordIndexForChar(wordStarts, char);
    const pi = idx >= 0 ? wordStarts[idx].pi : -1;
    if (pi < 0) return;
    const el = readingScrollRef.current?.querySelector(`[data-pi="${pi}"]`);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("flash");
      clearTimeout(flashRef.current);
      flashRef.current = setTimeout(() => el.classList.remove("flash"), 1200);
    }
  }

  /* ---------- note / link CRUD ---------- */
  function addNote(body) {
    if (!sel || !reading) return;
    const note = { id: uid(), start: sel.start, end: sel.end, snippet: sel.snippet, body, createdAt: Date.now() };
    setReading((r) => ({ ...r, notes: [...(r.notes || []), note] }));
    setSel(null);
    setCompose(null);
    setPanelTab("notes");
  }
  function deleteNote(id) {
    setReading((r) => ({ ...r, notes: (r.notes || []).filter((n) => n.id !== id) }));
  }
  function addLink(assignmentId, comment) {
    if (!sel || !reading || !assignmentId) return;
    const link = {
      id: uid(),
      assignmentId,
      readingId: reading.id,
      start: sel.start,
      end: sel.end,
      snippet: sel.snippet,
      comment,
      createdAt: Date.now(),
    };
    setMeta((m) => ({ ...m, links: [...m.links, link] }));
    setSel(null);
    setCompose(null);
    setPanelTab("links");
  }
  function deleteLink(id) {
    setMeta((m) => ({ ...m, links: m.links.filter((l) => l.id !== id) }));
  }

  const readingLinks = useMemo(
    () => (reading ? meta.links.filter((l) => l.readingId === reading.id) : []),
    [meta.links, reading]
  );

  /* ---------- mark ranges for rendering ---------- */
  const noteRanges = reading?.notes || [];
  const linkRanges = readingLinks;
  function partFlags(p) {
    let note = false, link = false;
    for (const n of noteRanges) if (n.start < p.end && n.end > p.start) { note = true; break; }
    for (const l of linkRanges) if (l.start < p.end && l.end > p.start) { link = true; break; }
    return { note, link };
  }


  /* ---------- JSON import / export ---------- */
  async function exportStudyJson() {
    const readings = [];
    for (const item of meta.readingIndex || []) {
      const fullReading = item.id === reading?.id ? reading : await loadKey(readingKey(item.id), null);
      if (fullReading) readings.push(fullReading);
    }

    const payload = {
      app: "ReadAlong",
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      meta,
      readings,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `readalong-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function importStudyJsonText(raw) {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      alert("That file is not valid JSON.");
      return;
    }

    const nextMeta = payload?.meta;
    const nextReadings = Array.isArray(payload?.readings) ? payload.readings : [];

    if (!nextMeta || !Array.isArray(nextMeta.classes) || !Array.isArray(nextMeta.readingIndex)) {
      alert("This does not look like a ReadAlong export file.");
      return;
    }

    // Remove current reading documents first so the import fully replaces the library.
    for (const item of meta.readingIndex || []) await deleteKey(readingKey(item.id));
    for (const r of nextReadings) {
      if (r?.id && typeof r.text === "string") await saveKey(readingKey(r.id), r);
    }

    const cleanedMeta = {
      classes: Array.isArray(nextMeta.classes) ? nextMeta.classes : [],
      assignments: Array.isArray(nextMeta.assignments) ? nextMeta.assignments : [],
      links: Array.isArray(nextMeta.links) ? nextMeta.links : [],
      readingIndex: Array.isArray(nextMeta.readingIndex) ? nextMeta.readingIndex : [],
      settings: { rate: 0.9, voiceURI: "", ...(nextMeta.settings || {}) },
    };

    stopPlayback();
    setMeta(cleanedMeta);
    setExpanded(Object.fromEntries(cleanedMeta.classes.map((c) => [c.id, true])));
    setActiveId(cleanedMeta.readingIndex[0]?.id || null);
    setView("reader");
    setModal(null);
  }

  async function handleImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await importStudyJsonText(await file.text());
  }

  /* ---------- class / chapter / reading / assignment ops ---------- */
  function createClass(name) {
    const c = { id: uid(), name, color: CLASS_COLORS[meta.classes.length % CLASS_COLORS.length], chapters: [] };
    setMeta((m) => ({ ...m, classes: [...m.classes, c] }));
    setExpanded((e) => ({ ...e, [c.id]: true }));
  }
  function createChapter(classId, name) {
    setMeta((m) => ({
      ...m,
      classes: m.classes.map((c) => (c.id === classId ? { ...c, chapters: [...c.chapters, { id: uid(), name }] } : c)),
    }));
  }
  async function createReading({ classId, chapterId, title, text }) {
    const id = uid();
    const r = { id, classId, chapterId, title, text, notes: [] };
    await saveKey(readingKey(id), r);
    setMeta((m) => ({ ...m, readingIndex: [...m.readingIndex, { id, classId, chapterId, title }] }));
    setActiveId(id);
    setView("reader");
  }
  async function deleteReading(id) {
    await deleteKey(readingKey(id));
    setMeta((m) => ({
      ...m,
      readingIndex: m.readingIndex.filter((r) => r.id !== id),
      links: m.links.filter((l) => l.readingId !== id),
    }));
    if (activeId === id) setActiveId(null);
  }
  function deleteClass(id) {
    const ids = meta.readingIndex.filter((r) => r.classId === id).map((r) => r.id);
    ids.forEach((rid) => deleteKey(readingKey(rid)));
    setMeta((m) => ({
      ...m,
      classes: m.classes.filter((c) => c.id !== id),
      readingIndex: m.readingIndex.filter((r) => r.classId !== id),
      assignments: m.assignments.filter((a) => a.classId !== id),
      links: m.links.filter((l) => !ids.includes(l.readingId)),
    }));
    if (ids.includes(activeId)) setActiveId(null);
  }
  function createAssignment({ classId, title, due, description }) {
    setMeta((m) => ({
      ...m,
      assignments: [...m.assignments, { id: uid(), classId, title, due, description, done: false }],
    }));
  }
  function toggleAssignment(id) {
    setMeta((m) => ({
      ...m,
      assignments: m.assignments.map((a) => (a.id === id ? { ...a, done: !a.done } : a)),
    }));
  }
  function deleteAssignment(id) {
    setMeta((m) => ({
      ...m,
      assignments: m.assignments.filter((a) => a.id !== id),
      links: m.links.filter((l) => l.assignmentId !== id),
    }));
  }

  function editText(newText) {
    // Editing text invalidates char offsets -> clear notes & links for this reading.
    setReading((r) => ({ ...r, text: newText, notes: [] }));
    setMeta((m) => ({ ...m, links: m.links.filter((l) => l.readingId !== reading.id) }));
    stopPlayback();
  }

  const className = (id) => meta.classes.find((c) => c.id === id)?.name || "";
  const assignmentName = (id) => meta.assignments.find((a) => a.id === id)?.title || "(deleted)";

  /* ================================================================ */
  /*  Render                                                          */
  /* ================================================================ */
  return (
    <div className="sr-root">
      <style>{CSS}</style>

      {/* Sidebar */}
      <aside className="sidebar">
        <div className="brand">
          <BookOpen size={20} />
          <div>
            <div className="brand-name">ReadAlong</div>
            <div className="brand-sub">listen, track, annotate</div>
          </div>
        </div>

        <div className="json-actions">
          <button className="json-btn" onClick={exportStudyJson} title="Export all classes, readings, notes, and assignments">
            <Download size={18} /> Backup
          </button>
          <button className="json-btn" onClick={() => importFileRef.current?.click()} title="Import a ReadAlong JSON file">
            <Upload size={18} /> Restore
          </button>
          <input ref={importFileRef} type="file" accept="application/json,.json" hidden onChange={handleImportFile} />
        </div>

        <button className="nav-pill" data-active={view === "assignments"} onClick={() => setView("assignments")}>
          <ClipboardList size={16} /> Assignments
          {meta.assignments.filter((a) => !a.done).length > 0 && (
            <span className="count">{meta.assignments.filter((a) => !a.done).length}</span>
          )}
        </button>

        <div className="side-head">
          <span>Classes</span>
          <button className="icon-btn" title="New class" onClick={() => setModal({ type: "class" })}>
            <Plus size={15} />
          </button>
        </div>

        <div className="tree">
          {meta.classes.length === 0 && <div className="empty-hint">Add a class to start organizing your readings.</div>}
          {meta.classes.map((c) => {
            const open = !!expanded[c.id];
            const chReadings = (chId) => meta.readingIndex.filter((r) => r.classId === c.id && r.chapterId === chId);
            const looseReadings = meta.readingIndex.filter((r) => r.classId === c.id && !r.chapterId);
            return (
              <div key={c.id} className="class-block">
                <div className="class-row">
                  <button className="disclose" onClick={() => setExpanded((e) => ({ ...e, [c.id]: !open }))}>
                    {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span className="dot" style={{ background: c.color }} />
                    <span className="class-name">{c.name}</span>
                  </button>
                  <div className="row-actions">
                    <button className="icon-btn sm" title="Add chapter" onClick={() => setModal({ type: "chapter", classId: c.id })}>
                      <Plus size={13} />
                    </button>
                    <button className="icon-btn sm" title="Delete class" onClick={() => setModal({ type: "confirm", text: `Delete "${c.name}" and all its readings?`, onYes: () => deleteClass(c.id) })}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                {open && (
                  <div className="chapters">
                    {c.chapters.map((ch) => (
                      <div key={ch.id} className="chapter-block">
                        <div className="chapter-row">
                          <FolderOpen size={13} /> <span>{ch.name}</span>
                          <button className="icon-btn sm push" title="New reading" onClick={() => setModal({ type: "reading", classId: c.id, chapterId: ch.id })}>
                            <Plus size={12} />
                          </button>
                        </div>
                        {chReadings(ch.id).map((r) => (
                          <ReadingItem key={r.id} r={r} active={activeId === r.id} onOpen={() => { setActiveId(r.id); setView("reader"); }} onDelete={() => setModal({ type: "confirm", text: `Delete "${r.title}"?`, onYes: () => deleteReading(r.id) })} />
                        ))}
                      </div>
                    ))}
                    {looseReadings.map((r) => (
                      <ReadingItem key={r.id} r={r} active={activeId === r.id} onOpen={() => { setActiveId(r.id); setView("reader"); }} onDelete={() => setModal({ type: "confirm", text: `Delete "${r.title}"?`, onYes: () => deleteReading(r.id) })} />
                    ))}
                    <button className="add-reading" onClick={() => setModal({ type: "reading", classId: c.id, chapterId: null })}>
                      <Plus size={12} /> Paste a reading
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      {/* Main */}
      <main className="main">
        {view === "assignments" ? (
          <AssignmentsView
            meta={meta}
            onNew={() => setModal({ type: "assignment" })}
            onToggle={toggleAssignment}
            onDelete={(id) => setModal({ type: "confirm", text: "Delete this assignment?", onYes: () => deleteAssignment(id) })}
            onOpenLink={(l) => { setActiveId(l.readingId); setView("reader"); setTimeout(() => scrollToChar(l.start), 400); }}
            className={className}
          />
        ) : !reading ? (
          <EmptyReader hasClasses={meta.classes.length > 0} onAdd={() => setModal({ type: meta.classes.length ? "reading" : "class" })} />
        ) : (
          <div className="reader-wrap">
            {/* Toolbar */}
            <div className="toolbar">
              <div className="toolbar-left">
                <div className="r-title">{reading.title}</div>
                <div className="r-meta">{className(reading.classId)}</div>
              </div>
              <div className="transport">
                <button className="play-btn" onClick={togglePlay} title="Play / pause (space)">
                  {isPlaying && !isPaused ? <Pause size={18} /> : <Play size={18} />}
                </button>
                <button className="t-btn" onClick={stopPlayback} title="Stop" disabled={!isPlaying}>
                  <Square size={15} />
                </button>
                <div className="speed">
                  <Gauge size={15} />
                  <input type="range" min="0.5" max="2.5" step="0.05" value={meta.settings.rate} onChange={(e) => changeRateValue(parseFloat(e.target.value))} onMouseUp={commitRate} onTouchEnd={commitRate} onKeyUp={commitRate} />
                  <span className="speed-val">{meta.settings.rate.toFixed(2)}×</span>
                </div>
                <label className="voice">
                  <Volume2 size={15} />
                  <select value={meta.settings.voiceURI} onChange={(e) => changeVoice(e.target.value)}>
                    <option value="">Default voice</option>
                    {voices.map((v) => (
                      <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>
                    ))}
                  </select>
                </label>
                <button className="t-btn" title="Edit text" onClick={() => setModal({ type: "edittext" })}>
                  <Edit3 size={15} />
                </button>
              </div>
            </div>

            {!ttsSupported && <div className="warn">Your browser doesn't expose speech synthesis here. Try opening this in Chrome or Safari.</div>}

            {/* Selection action bar */}
            {sel && !compose && (
              <div className="sel-bar">
                <span className="sel-snippet">“{sel.snippet.slice(0, 60)}{sel.snippet.length > 60 ? "…" : ""}”</span>
                <button className="chip" onClick={() => { setCompose({ type: "note", ...sel, body: "" }); setPanelTab("notes"); }}>
                  <StickyNote size={14} /> Add note
                </button>
                <button className="chip" onClick={() => { setCompose({ type: "link", ...sel, assignmentId: meta.assignments[0]?.id || "", comment: "" }); setPanelTab("links"); }}>
                  <Link2 size={14} /> Link to assignment
                </button>
                <button className="chip ghost" onClick={() => setSel(null)}><X size={14} /></button>
              </div>
            )}

            <div className="reader-body">
              {/* Reading surface */}
              <div className="reading-surface" ref={readingScrollRef} onMouseUp={onReadingMouseUp}>
                <div className="reading-text">
                  {parts.map((p, i) => {
                    if (!p.isWord) {
                      return (
                        <span key={i} data-start={p.start}>
                          {p.text.split("\n").map((seg, k, arr) => (
                            <React.Fragment key={k}>
                              {seg}
                              {k < arr.length - 1 && <br />}
                            </React.Fragment>
                          ))}
                        </span>
                      );
                    }
                    const { note, link } = partFlags(p);
                    const cls = [
                      "w",
                      i === currentWordPi ? "active" : "",
                      note ? "note" : "",
                      link ? "link" : "",
                    ].join(" ").trim();
                    return (
                      <span key={i} className={cls} data-pi={i} data-start={p.start} data-word="1">
                        {p.text}
                      </span>
                    );
                  })}
                </div>
              </div>

              {/* Right panel */}
              <div className="panel">
                <div className="panel-tabs">
                  <button data-active={panelTab === "notes"} onClick={() => setPanelTab("notes")}>
                    <StickyNote size={14} /> Notes <span className="pcount">{(reading.notes || []).length}</span>
                  </button>
                  <button data-active={panelTab === "links"} onClick={() => setPanelTab("links")}>
                    <Link2 size={14} /> Assignments <span className="pcount">{readingLinks.length}</span>
                  </button>
                </div>

                {/* composer */}
                {compose && compose.type === "note" && panelTab === "notes" && (
                  <div className="composer">
                    <div className="comp-snip">“{compose.snippet.slice(0, 80)}{compose.snippet.length > 80 ? "…" : ""}”</div>
                    <textarea autoFocus placeholder="Your note…" value={compose.body} onChange={(e) => setCompose({ ...compose, body: e.target.value })} />
                    <div className="comp-actions">
                      <button className="btn ghost" onClick={() => setCompose(null)}>Cancel</button>
                      <button className="btn" disabled={!compose.body.trim()} onClick={() => addNote(compose.body.trim())}>Save note</button>
                    </div>
                  </div>
                )}
                {compose && compose.type === "link" && panelTab === "links" && (
                  <div className="composer">
                    <div className="comp-snip">“{compose.snippet.slice(0, 80)}{compose.snippet.length > 80 ? "…" : ""}”</div>
                    {meta.assignments.length === 0 ? (
                      <div className="empty-hint">No assignments yet. Create one in the Assignments tab first.</div>
                    ) : (
                      <select value={compose.assignmentId} onChange={(e) => setCompose({ ...compose, assignmentId: e.target.value })}>
                        {meta.assignments.map((a) => (
                          <option key={a.id} value={a.id}>{a.title}</option>
                        ))}
                      </select>
                    )}
                    <textarea placeholder="Comment (why this section matters)…" value={compose.comment} onChange={(e) => setCompose({ ...compose, comment: e.target.value })} />
                    <div className="comp-actions">
                      <button className="btn ghost" onClick={() => setCompose(null)}>Cancel</button>
                      <button className="btn" disabled={!compose.assignmentId} onClick={() => addLink(compose.assignmentId, compose.comment.trim())}>Link</button>
                    </div>
                  </div>
                )}

                <div className="panel-list">
                  {panelTab === "notes" && (
                    (reading.notes || []).length === 0 && !compose ? (
                      <div className="empty-hint">Select text in the reading, then “Add note”. Notes show up here.</div>
                    ) : (
                      [...(reading.notes || [])].sort((a, b) => a.start - b.start).map((n) => (
                        <div key={n.id} className="card note-card" onClick={() => scrollToChar(n.start)}>
                          <div className="card-snip"><Highlighter size={12} /> {n.snippet.slice(0, 70)}{n.snippet.length > 70 ? "…" : ""}</div>
                          <div className="card-body">{n.body}</div>
                          <button className="card-del" onClick={(e) => { e.stopPropagation(); deleteNote(n.id); }}><Trash2 size={13} /></button>
                        </div>
                      ))
                    )
                  )}
                  {panelTab === "links" && (
                    readingLinks.length === 0 && !compose ? (
                      <div className="empty-hint">Select text, then “Link to assignment” to connect a passage to an assignment.</div>
                    ) : (
                      [...readingLinks].sort((a, b) => a.start - b.start).map((l) => (
                        <div key={l.id} className="card link-card" onClick={() => scrollToChar(l.start)}>
                          <div className="card-asgn"><ClipboardList size={12} /> {assignmentName(l.assignmentId)}</div>
                          <div className="card-snip">{l.snippet.slice(0, 70)}{l.snippet.length > 70 ? "…" : ""}</div>
                          {l.comment && <div className="card-body">{l.comment}</div>}
                          <button className="card-del" onClick={(e) => { e.stopPropagation(); deleteLink(l.id); }}><Trash2 size={13} /></button>
                        </div>
                      ))
                    )
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Modals */}
      {modal && (
        <Modal onClose={() => setModal(null)}>
          {modal.type === "class" && (
            <SimpleForm title="New class" fields={[{ key: "name", label: "Class name", placeholder: "e.g. Biology 201" }]} submitLabel="Create class" onSubmit={(v) => { if (v.name?.trim()) createClass(v.name.trim()); setModal(null); }} />
          )}
          {modal.type === "chapter" && (
            <SimpleForm title="New chapter" fields={[{ key: "name", label: "Chapter name", placeholder: "e.g. Chapter 4 — Cells" }]} submitLabel="Add chapter" onSubmit={(v) => { if (v.name?.trim()) createChapter(modal.classId, v.name.trim()); setModal(null); }} />
          )}
          {modal.type === "assignment" && (
            <AssignmentForm classes={meta.classes} onSubmit={(v) => { createAssignment(v); setModal(null); }} />
          )}
          {modal.type === "reading" && (
            <ReadingForm classes={meta.classes} defaultClassId={modal.classId} defaultChapterId={modal.chapterId} onSubmit={(v) => { createReading(v); setModal(null); }} />
          )}
          {modal.type === "edittext" && (
            <EditTextForm text={reading.text} onSubmit={(t) => { editText(t); setModal(null); }} />
          )}
          {modal.type === "confirm" && (
            <div className="confirm">
              <p>{modal.text}</p>
              <div className="comp-actions">
                <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
                <button className="btn danger" onClick={() => { modal.onYes(); setModal(null); }}>Delete</button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Subcomponents                                                      */
/* ------------------------------------------------------------------ */
function ReadingItem({ r, active, onOpen, onDelete }) {
  return (
    <div className={"reading-item" + (active ? " active" : "")} onClick={onOpen}>
      <FileText size={13} />
      <span className="ri-title">{r.title}</span>
      <button className="icon-btn sm hideable" onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Delete">
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function EmptyReader({ hasClasses, onAdd }) {
  return (
    <div className="empty-reader">
      <div className="empty-card">
        <BookOpen size={34} />
        <h2>Read along, hands-free</h2>
        <p>Paste a chapter or assignment text, then press play. The current word is highlighted and the page scrolls itself, at whatever speed feels right.</p>
        <button className="btn big" onClick={onAdd}>
          <Plus size={16} /> {hasClasses ? "Paste a reading" : "Add your first class"}
        </button>
      </div>
    </div>
  );
}

function AssignmentsView({ meta, onNew, onToggle, onDelete, onOpenLink, className }) {
  const linksFor = (aid) => meta.links.filter((l) => l.assignmentId === aid);
  return (
    <div className="assignments-view">
      <div className="av-head">
        <h2><ClipboardList size={20} /> Assignments</h2>
        <button className="btn" onClick={onNew}><Plus size={15} /> New assignment</button>
      </div>
      {meta.assignments.length === 0 && <div className="empty-hint big">No assignments yet. Create one, then link readings to it.</div>}
      <div className="av-list">
        {meta.assignments.map((a) => {
          const links = linksFor(a.id);
          return (
            <div key={a.id} className={"asgn-card" + (a.done ? " done" : "")}>
              <div className="asgn-top">
                <button className="check" onClick={() => onToggle(a.id)}>{a.done && <Check size={13} />}</button>
                <div className="asgn-main">
                  <div className="asgn-title">{a.title}</div>
                  <div className="asgn-meta">
                    {a.classId && <span className="tag">{className(a.classId)}</span>}
                    {a.due && <span className="due"><Clock size={12} /> {a.due}</span>}
                  </div>
                  {a.description && <div className="asgn-desc">{a.description}</div>}
                </div>
                <button className="icon-btn" onClick={() => onDelete(a.id)} title="Delete"><Trash2 size={14} /></button>
              </div>
              {links.length > 0 && (
                <div className="asgn-links">
                  <div className="al-head"><Link2 size={12} /> Linked passages</div>
                  {links.map((l) => (
                    <div key={l.id} className="al-row" onClick={() => onOpenLink(l)}>
                      <span className="al-snip">“{l.snippet.slice(0, 60)}{l.snippet.length > 60 ? "…" : ""}”</span>
                      {l.comment && <span className="al-comment">— {l.comment}</span>}
                      <ArrowLeft size={12} className="al-go" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Modal({ children, onClose }) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <button className="modal-x" onClick={onClose}><X size={16} /></button>
        {children}
      </div>
    </div>
  );
}

function SimpleForm({ title, fields, submitLabel, onSubmit }) {
  const [v, setV] = useState({});
  return (
    <div className="form">
      <h3>{title}</h3>
      {fields.map((f) => (
        <label key={f.key}>
          <span>{f.label}</span>
          <input autoFocus placeholder={f.placeholder} value={v[f.key] || ""} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} onKeyDown={(e) => e.key === "Enter" && onSubmit(v)} />
        </label>
      ))}
      <div className="comp-actions">
        <button className="btn" onClick={() => onSubmit(v)}>{submitLabel}</button>
      </div>
    </div>
  );
}

function ReadingForm({ classes, defaultClassId, defaultChapterId, onSubmit }) {
  const [classId, setClassId] = useState(defaultClassId || classes[0]?.id || "");
  const [chapterId, setChapterId] = useState(defaultChapterId || "");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const chapters = classes.find((c) => c.id === classId)?.chapters || [];
  return (
    <div className="form">
      <h3>Paste a reading</h3>
      <div className="form-row">
        <label>
          <span>Class</span>
          <select value={classId} onChange={(e) => { setClassId(e.target.value); setChapterId(""); }}>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>
          <span>Chapter (optional)</span>
          <select value={chapterId} onChange={(e) => setChapterId(e.target.value)}>
            <option value="">— none —</option>
            {chapters.map((ch) => <option key={ch.id} value={ch.id}>{ch.name}</option>)}
          </select>
        </label>
      </div>
      <label>
        <span>Title</span>
        <input autoFocus placeholder="e.g. Section 2.3 — Photosynthesis" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        <span>Text</span>
        <textarea className="big-paste" placeholder="Paste the reading here…" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="comp-actions">
        <button className="btn" disabled={!classId || !title.trim() || !text.trim()} onClick={() => onSubmit({ classId, chapterId: chapterId || null, title: title.trim(), text })}>
          Save & open
        </button>
      </div>
    </div>
  );
}

function EditTextForm({ text, onSubmit }) {
  const [t, setT] = useState(text);
  return (
    <div className="form">
      <h3>Edit text</h3>
      <p className="warn-inline">Heads up: editing the text clears this reading's notes and assignment links (their positions would no longer match).</p>
      <textarea className="big-paste" value={t} onChange={(e) => setT(e.target.value)} />
      <div className="comp-actions">
        <button className="btn" disabled={!t.trim()} onClick={() => onSubmit(t)}>Save text</button>
      </div>
    </div>
  );
}

function AssignmentForm({ classes, onSubmit }) {
  const [classId, setClassId] = useState(classes[0]?.id || "");
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [description, setDescription] = useState("");
  return (
    <div className="form">
      <h3>New assignment</h3>
      <label>
        <span>Title</span>
        <input autoFocus placeholder="e.g. Lab report — Ch. 4" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <div className="form-row">
        <label>
          <span>Class</span>
          <select value={classId} onChange={(e) => setClassId(e.target.value)}>
            <option value="">— none —</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>
          <span>Due</span>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
      </div>
      <label>
        <span>Notes (optional)</span>
        <textarea placeholder="Details…" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="comp-actions">
        <button className="btn" disabled={!title.trim()} onClick={() => onSubmit({ classId, title: title.trim(), due, description: description.trim() })}>
          Create
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=Inter:wght@400;500;600;700&display=swap');

.sr-root{
  --ink:#23201a; --paper:#fbf7f0; --paper-edge:#efe7d8;
  --chrome:#1d2230; --chrome-2:#252b3b; --chrome-line:#333a4c;
  --text-light:#e7eaf2; --muted:#9aa2b6;
  --amber:#f2b43b; --amber-soft:rgba(242,180,59,.34);
  --accent:#e89b3c; --teal:#2ba6a4; --violet:#8a7be6; --danger:#d9637b;
  position:fixed; inset:0; display:flex; font-family:'Inter',system-ui,sans-serif;
  color:var(--text-light); background:var(--chrome); overflow:hidden;
  -webkit-font-smoothing:antialiased;
}
.sr-root *{box-sizing:border-box}
.sr-root button{font-family:inherit;cursor:pointer;border:none;background:none;color:inherit}
.sr-root input,.sr-root textarea,.sr-root select{font-family:inherit}

/* sidebar */
.sidebar{width:280px;flex-shrink:0;background:var(--chrome);border-right:1px solid var(--chrome-line);
  display:flex;flex-direction:column;padding:16px 12px;overflow-y:auto}
.brand{display:flex;align-items:center;gap:10px;padding:4px 6px 14px;color:var(--amber)}
.brand-name{font-size:16px;font-weight:700;color:var(--text-light);letter-spacing:.2px}
.brand-sub{font-size:11px;color:var(--muted);font-weight:500}
.json-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:0 0 10px}
.json-btn{
    display:flex;
    align-items:center;
    justify-content:center;
    gap:8px;

    background:var(--chrome-2);
    color:var(--muted);

    border:1px solid var(--chrome-line)!important;
    border-radius:12px;

    padding:12px 14px;

    font-size:15px;
    font-weight:600;

    white-space:nowrap;
    line-height:1;
}
.json-btn:hover{color:var(--text-light);border-color:var(--accent)!important}
.nav-pill{display:flex;align-items:center;gap:8px;width:100%;padding:9px 12px;border-radius:9px;
  font-size:13px;font-weight:600;color:var(--muted);background:transparent;margin-bottom:6px}
.nav-pill:hover{background:var(--chrome-2);color:var(--text-light)}
.nav-pill[data-active="true"]{background:var(--chrome-2);color:var(--text-light)}
.nav-pill .count{margin-left:auto;background:var(--accent);color:#1b1206;font-size:11px;font-weight:700;
  padding:1px 7px;border-radius:20px}
.side-head{display:flex;align-items:center;justify-content:space-between;margin:14px 6px 6px;
  font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--muted)}
.icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;
  border-radius:6px;color:var(--muted)}
.icon-btn:hover{background:var(--chrome-2);color:var(--text-light)}
.icon-btn.sm{width:20px;height:20px}
.empty-hint{font-size:12px;color:var(--muted);padding:8px 6px;line-height:1.5}
.empty-hint.big{font-size:14px;padding:30px;text-align:center}

.tree{display:flex;flex-direction:column;gap:2px}
.class-block{margin-bottom:2px}
.class-row{display:flex;align-items:center;border-radius:7px}
.class-row:hover{background:var(--chrome-2)}
.disclose{display:flex;align-items:center;gap:7px;flex:1;padding:7px 6px;font-size:13px;font-weight:600;min-width:0}
.disclose .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.class-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row-actions{display:flex;opacity:0;padding-right:4px}
.class-row:hover .row-actions{opacity:1}
.chapters{padding-left:14px;display:flex;flex-direction:column;gap:1px;margin:2px 0 4px}
.chapter-row{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;
  color:var(--muted);text-transform:uppercase;letter-spacing:.5px;padding:5px 6px}
.chapter-row .push{margin-left:auto;opacity:0}
.chapter-row:hover .push{opacity:1}
.reading-item{display:flex;align-items:center;gap:7px;padding:6px 8px;border-radius:6px;
  font-size:13px;color:var(--text-light);cursor:pointer;margin-left:4px}
.reading-item:hover{background:var(--chrome-2)}
.reading-item.active{background:var(--accent);color:#1b1206;font-weight:600}
.reading-item.active .icon-btn{color:#1b1206}
.ri-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hideable{opacity:0}
.reading-item:hover .hideable{opacity:1}
.add-reading{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);
  padding:6px 8px;margin-left:4px;border-radius:6px}
.add-reading:hover{color:var(--accent)}

/* main */
.main{flex:1;min-width:0;background:var(--chrome-2);display:flex;flex-direction:column;overflow:hidden}

/* reader */
.reader-wrap{flex:1;display:flex;flex-direction:column;min-height:0}
.toolbar{display:flex;align-items:center;gap:16px;padding:14px 22px;border-bottom:1px solid var(--chrome-line);
  background:var(--chrome);flex-wrap:wrap}
.toolbar-left{min-width:160px}
.r-title{font-size:15px;font-weight:600}
.r-meta{font-size:12px;color:var(--muted)}
.transport{display:flex;align-items:center;gap:10px;margin-left:auto;flex-wrap:wrap}
.play-btn{width:40px;height:40px;border-radius:50%;background:var(--accent);color:#1b1206;
  display:flex;align-items:center;justify-content:center;box-shadow:0 2px 12px rgba(232,155,60,.35)}
.play-btn:hover{transform:scale(1.05)}
.t-btn{width:34px;height:34px;border-radius:8px;background:var(--chrome-2);color:var(--text-light);
  display:flex;align-items:center;justify-content:center}
.t-btn:hover:not(:disabled){background:var(--chrome-line)}
.t-btn:disabled{opacity:.35;cursor:default}
.speed{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12px}
.speed input[type=range]{width:90px;accent-color:var(--accent)}
.speed-val{color:var(--text-light);font-variant-numeric:tabular-nums;min-width:42px}
.voice{display:flex;align-items:center;gap:6px;color:var(--muted)}
.voice select{background:var(--chrome-2);color:var(--text-light);border:1px solid var(--chrome-line);
  border-radius:7px;padding:6px 8px;font-size:12px;max-width:160px}
.warn{background:#3a2a18;color:#f2c98b;padding:8px 22px;font-size:13px}

/* selection bar */
.sel-bar{display:flex;align-items:center;gap:10px;padding:9px 22px;background:var(--chrome);
  border-bottom:1px solid var(--chrome-line)}
.sel-snippet{font-size:12px;color:var(--muted);font-style:italic;max-width:40%;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.chip{display:flex;align-items:center;gap:6px;padding:6px 11px;border-radius:7px;font-size:12px;
  font-weight:600;background:var(--chrome-2);color:var(--text-light)}
.chip:hover{background:var(--chrome-line)}
.chip.ghost{margin-left:auto;background:transparent;color:var(--muted);padding:6px}

/* reader body */
.reader-body{flex:1;display:flex;min-height:0}
.reading-surface{flex:1;overflow-y:auto;background:var(--paper);padding:46px 8% 120px;position:relative}
.reading-text{max-width:680px;margin:0 auto;font-family:'Newsreader',Georgia,serif;
  font-size:21px;line-height:1.85;color:var(--ink);font-weight:400;letter-spacing:.1px}
.reading-text .w{border-radius:4px;transition:background-color .08s ease;padding:0 .5px;cursor:pointer}
.reading-text .w:hover{background:rgba(0,0,0,.05)}
.reading-text .w.note{border-bottom:2px solid var(--teal)}
.reading-text .w.link{background:rgba(138,123,230,.16);border-bottom:2px solid var(--violet)}
.reading-text .w.active{background:var(--amber-soft);box-shadow:0 0 0 2px var(--amber-soft);
  color:#1c1608;font-weight:500}
.reading-text .w.flash{animation:flash 1.1s ease}
@keyframes flash{0%,100%{background:transparent}30%{background:rgba(242,180,59,.5)}}

/* right panel */
.panel{width:320px;flex-shrink:0;background:var(--chrome);border-left:1px solid var(--chrome-line);
  display:flex;flex-direction:column;min-height:0}
.panel-tabs{display:flex;border-bottom:1px solid var(--chrome-line)}
.panel-tabs button{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:12px 8px;
  font-size:12px;font-weight:600;color:var(--muted);border-bottom:2px solid transparent}
.panel-tabs button[data-active="true"]{color:var(--text-light);border-bottom-color:var(--accent)}
.pcount{background:var(--chrome-2);border-radius:20px;padding:0 6px;font-size:10px}
.panel-list{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.card{position:relative;background:var(--chrome-2);border-radius:9px;padding:11px 12px;cursor:pointer;
  border:1px solid transparent}
.card:hover{border-color:var(--chrome-line)}
.card-snip{font-size:12px;color:var(--muted);font-style:italic;margin-bottom:5px;display:flex;
  align-items:center;gap:5px}
.note-card .card-snip{color:var(--teal);font-style:normal}
.card-body{font-size:13px;line-height:1.5;color:var(--text-light)}
.card-asgn{font-size:12px;font-weight:600;color:var(--violet);display:flex;align-items:center;gap:5px;margin-bottom:5px}
.link-card .card-snip{font-style:italic}
.card-del{position:absolute;top:9px;right:9px;color:var(--muted);opacity:0}
.card:hover .card-del{opacity:1}
.card-del:hover{color:var(--danger)}

/* composer */
.composer{margin:12px 12px 4px;background:var(--chrome-2);border-radius:10px;padding:11px;
  border:1px solid var(--chrome-line)}
.comp-snip{font-size:12px;color:var(--muted);font-style:italic;margin-bottom:8px}
.composer textarea,.composer select{width:100%;background:var(--chrome);color:var(--text-light);
  border:1px solid var(--chrome-line);border-radius:7px;padding:8px;font-size:13px;margin-bottom:8px}
.composer textarea{min-height:64px;resize:vertical}
.comp-actions{display:flex;gap:8px;justify-content:flex-end}
.btn{background:var(--accent);color:#1b1206;font-weight:600;font-size:13px;padding:8px 15px;border-radius:8px}
.btn:hover{filter:brightness(1.06)}
.btn:disabled{opacity:.4;cursor:default}
.btn.ghost{background:var(--chrome-line);color:var(--text-light)}
.btn.danger{background:var(--danger);color:#fff}
.btn.big{font-size:14px;padding:11px 20px;display:inline-flex;align-items:center;gap:8px}

/* empty reader */
.empty-reader{flex:1;display:flex;align-items:center;justify-content:center;padding:24px}
.empty-card{max-width:420px;text-align:center;color:var(--text-light)}
.empty-card svg{color:var(--accent);margin-bottom:16px}
.empty-card h2{font-family:'Newsreader',serif;font-size:26px;margin:0 0 10px;font-weight:600}
.empty-card p{color:var(--muted);font-size:14px;line-height:1.6;margin:0 0 22px}

/* assignments */
.assignments-view{flex:1;overflow-y:auto;padding:30px 36px}
.av-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:22px}
.av-head h2{display:flex;align-items:center;gap:10px;font-family:'Newsreader',serif;font-size:24px;font-weight:600;margin:0}
.av-list{display:flex;flex-direction:column;gap:12px;max-width:760px}
.asgn-card{background:var(--chrome);border:1px solid var(--chrome-line);border-radius:12px;padding:16px 18px}
.asgn-card.done{opacity:.55}
.asgn-top{display:flex;gap:13px;align-items:flex-start}
.check{width:22px;height:22px;border-radius:6px;border:2px solid var(--chrome-line);flex-shrink:0;
  display:flex;align-items:center;justify-content:center;margin-top:2px;color:var(--accent)}
.check:hover{border-color:var(--accent)}
.asgn-main{flex:1;min-width:0}
.asgn-title{font-size:15px;font-weight:600}
.asgn-card.done .asgn-title{text-decoration:line-through}
.asgn-meta{display:flex;gap:10px;align-items:center;margin-top:5px}
.tag{font-size:11px;background:var(--chrome-2);padding:2px 9px;border-radius:20px;color:var(--muted);font-weight:600}
.due{font-size:12px;color:var(--accent);display:flex;align-items:center;gap:4px}
.asgn-desc{font-size:13px;color:var(--muted);margin-top:8px;line-height:1.5}
.asgn-links{margin-top:13px;padding-top:12px;border-top:1px solid var(--chrome-line)}
.al-head{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--violet);
  display:flex;align-items:center;gap:5px;margin-bottom:8px}
.al-row{display:flex;align-items:center;gap:8px;font-size:13px;padding:6px 8px;border-radius:7px;cursor:pointer}
.al-row:hover{background:var(--chrome-2)}
.al-snip{font-style:italic;color:var(--text-light)}
.al-comment{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.al-go{margin-left:auto;color:var(--muted);transform:rotate(180deg)}

/* overlay / modal */
.overlay{position:fixed;inset:0;background:rgba(10,12,18,.62);backdrop-filter:blur(3px);
  display:flex;align-items:center;justify-content:center;z-index:50;padding:20px}
.modal{background:var(--chrome);border:1px solid var(--chrome-line);border-radius:16px;
  width:100%;max-width:560px;padding:26px;position:relative;max-height:88vh;overflow-y:auto;
  box-shadow:0 20px 60px rgba(0,0,0,.5)}
.modal-x{position:absolute;top:16px;right:16px;color:var(--muted)}
.modal-x:hover{color:var(--text-light)}
.form h3{font-family:'Newsreader',serif;font-size:20px;font-weight:600;margin:0 0 18px}
.form label{display:block;margin-bottom:14px}
.form label>span{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px}
.form input,.form select,.form textarea{width:100%;background:var(--chrome-2);color:var(--text-light);
  border:1px solid var(--chrome-line);border-radius:8px;padding:10px 12px;font-size:14px}
.form textarea{min-height:80px;resize:vertical;line-height:1.5}
.big-paste{min-height:200px!important;font-size:14px;line-height:1.6}
.form-row{display:flex;gap:12px}
.form-row label{flex:1}
.warn-inline{font-size:13px;color:#f2c98b;background:#3a2a18;padding:9px 12px;border-radius:8px;
  margin-bottom:14px;line-height:1.5}
.confirm p{font-size:15px;line-height:1.5;margin:0 0 20px}

@media (max-width:880px){
  .panel{display:none}
  .sidebar{width:230px}
}
@media (prefers-reduced-motion:reduce){
  .reading-text .w{transition:none}
  *{scroll-behavior:auto!important}
}
.reading-surface::-webkit-scrollbar,.panel-list::-webkit-scrollbar,.sidebar::-webkit-scrollbar,
.assignments-view::-webkit-scrollbar,.modal::-webkit-scrollbar{width:10px}
.reading-surface::-webkit-scrollbar-thumb{background:#d9cdb6;border-radius:8px}
.panel-list::-webkit-scrollbar-thumb,.sidebar::-webkit-scrollbar-thumb,
.assignments-view::-webkit-scrollbar-thumb,.modal::-webkit-scrollbar-thumb{background:var(--chrome-line);border-radius:8px}
`;
