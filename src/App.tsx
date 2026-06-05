import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Tesseract from "tesseract.js";

type ScreenshotStatus = "pending" | "processing" | "done" | "error";

interface Screenshot {
  id: string;
  name: string;
  dataUrl: string;
  text: string;
  status: ScreenshotStatus;
  progress: number;
  createdAt: number;
}

type NoteType = "note" | "task" | "reminder";

interface Note {
  id: string;
  screenshotId: string | null;
  content: string;
  type: NoteType;
  dueDate?: string | null;
  reminderTime?: string | null; // ISO datetime for alarm
  alarmFired: boolean;
  completed: boolean;
  important: boolean;
  tags: string[];
  createdAt: number;
}

const STORAGE_KEY = "screen-notes-v2";

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/* ──────── Share via link ──────── */

async function shareNote(note: Note) {
  const payload = {
    id: note.id,
    content: note.content,
    type: note.type,
    important: note.important,
    dueDate: note.dueDate,
    tags: note.tags,
    createdAt: note.createdAt,
  };
  const encoded = btoa(encodeURIComponent(JSON.stringify(payload)));
  const url = `${window.location.origin}${window.location.pathname}?shared=${encoded}`;

  if (navigator.share) {
    try {
      await navigator.share({
        title: `ScreenNote — ${note.type}`,
        text: note.content,
        url,
      });
      return;
    } catch {
      // user cancelled or fallback
    }
  }

  // Fallback: copy to clipboard
  try {
    await navigator.clipboard.writeText(`${note.content}\n\n${url}`);
    return "copied";
  } catch {
    // final fallback
    prompt("Copy this share link:", url);
    return "prompted";
  }
}

/* ──────── Alarm beep sound ──────── */

function playAlarmSound() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(660, ctx.currentTime + 0.15);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.3);
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.6);
  } catch {
    // silent fallback
  }
}

/* ──────── Request notification permission ──────── */

async function ensureNotificationPermission(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

function fireNotification(note: Note) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  try {
    const n = new Notification("🔔 ScreenNotes Alarm", {
      body: note.content.slice(0, 120),
      tag: note.id,
      requireInteraction: true,
      // @ts-expect-error vibrate is supported in many browsers but not in TS types
      vibrate: [200, 100, 200],
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    playAlarmSound();
  } catch {
    playAlarmSound();
  }
}

/* ──────── Extract insights (OCR) ──────── */

function extractInsights(text: string): Omit<Note, "id" | "screenshotId" | "createdAt" | "reminderTime" | "alarmFired">[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const insights: Omit<Note, "id" | "screenshotId" | "createdAt" | "reminderTime" | "alarmFired">[] = [];
  const dateRegex =
    /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}(?:,? \d{4})?|tomorrow|today|next (?:mon|tue|wed|thu|fri|sat|sun|week))\b/i;
  const timeRegex = /\b(\d{1,2}:\d{2}\s?(?:am|pm)?)\b/i;
  const taskKeywords = /\b(todo|to-do|task|buy|call|email|send|schedule|meeting|remind|deadline|due|finish|complete)\b/i;
  const bulletRegex = /^(\-|\*|•|\d+\.)\s+/;

  const seen = new Set<string>();

  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line.length < 3) continue;
    if (seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());

    const hasDate = dateRegex.test(line);
    const hasTime = timeRegex.test(line);
    const isTasky = taskKeywords.test(line) || bulletRegex.test(line);
    const isImportant = /!|important|urgent|asap|critical/i.test(line);

    let type: NoteType = "note";
    if (hasDate || hasTime) type = "reminder";
    else if (isTasky) type = "task";

    let dueDate: string | null = null;
    const dateMatch = line.match(dateRegex);
    if (dateMatch) {
      const parsed = new Date(dateMatch[0]);
      if (!isNaN(parsed.getTime())) {
        dueDate = parsed.toISOString().slice(0, 10);
      }
    }

    const tags: string[] = [];
    if (hasDate) tags.push("date");
    if (hasTime) tags.push("time");
    if (isImportant) tags.push("important");

    insights.push({
      content: line.replace(bulletRegex, ""),
      type,
      dueDate,
      completed: false,
      important: isImportant,
      tags,
    });
  }

  if (insights.length === 0 && text.trim()) {
    insights.push({
      content: text.slice(0, 280),
      type: "note",
      dueDate: null,
      completed: false,
      important: false,
      tags: [],
    });
  }

  return insights.slice(0, 12);
}

function useLocalStorage<T>(key: string, initial: T) {
  const [state, setState] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(state));
  }, [key, state]);
  return [state, setState] as const;
}

function toLocalDatetimeString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}T${h}:${min}`;
}

/* ──────── Shared note decoder ──────── */

function decodeSharedNote(): { content: string; type: NoteType } | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("shared");
    if (!raw) return null;
    const json = JSON.parse(decodeURIComponent(atob(raw)));
    return { content: json.content || "", type: json.type || "note" };
  } catch {
    return null;
  }
}

/* ════════════════════════════════════
   APP
   ════════════════════════════════════ */

export default function App() {

  const [screenshots, setScreenshots] = useLocalStorage<Screenshot[]>(`${STORAGE_KEY}:shots`, []);
  const [notes, setNotes] = useLocalStorage<Note[]>(`${STORAGE_KEY}:notes`, []);
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filterType, setFilterType] = useState<NoteType | "all">("all");
  const [showCompleted, setShowCompleted] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const selectedShot = useMemo(
    () => screenshots.find((s) => s.id === selectedShotId) || null,
    [screenshots, selectedShotId]
  );

  /* ── toast ── */
  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 2500);
  }, []);

  /* ── handle shared link ── */
  useEffect(() => {
    const shared = decodeSharedNote();
    if (shared) {
      showToast(`📎 Received shared ${shared.type}: "${shared.content.slice(0, 50)}…"`);
    }
  }, [showToast]);

  /* ── process screenshot ── */
  const processFile = useCallback(async (file: File) => {
    const id = uid();
    const dataUrl = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(file);
    });

    const shot: Screenshot = {
      id, name: file.name, dataUrl, text: "", status: "pending", progress: 0, createdAt: Date.now(),
    };
    setScreenshots((s) => [shot, ...s]);
    setSelectedShotId(id);
    setScreenshots((s) => s.map((x) => (x.id === id ? { ...x, status: "processing" } : x)));

    try {
      const { data } = await Tesseract.recognize(dataUrl, "eng", {
        logger: (m) => {
          if (m.status === "recognizing text" && m.progress) {
            setScreenshots((s) =>
              s.map((x) => (x.id === id ? { ...x, progress: Math.round(m.progress * 100) } : x))
            );
          }
        },
      });

      const text = data.text.trim();
      setScreenshots((s) =>
        s.map((x) => (x.id === id ? { ...x, text, status: "done", progress: 100 } : x))
      );

      const insights = extractInsights(text);
      const newNotes: Note[] = insights.map((ins) => ({
        id: uid(),
        screenshotId: id,
        createdAt: Date.now(),
        reminderTime: null,
        alarmFired: false,
        ...ins,
      }));
      setNotes((n) => [...newNotes, ...n]);
      showToast(`📸 Extracted ${newNotes.length} insights from "${file.name}"`);
    } catch (e) {
      console.error(e);
      setScreenshots((s) => s.map((x) => (x.id === id ? { ...x, status: "error" } : x)));
    }
  }, [setNotes, setScreenshots, showToast]);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      Array.from(files).forEach((f) => {
        if (f.type.startsWith("image/")) processFile(f);
      });
    },
    [processFile]
  );

  /* ── drag & drop ── */
  useEffect(() => {
    const el = dropRef.current;
    if (!el) return;
    const onDragOver = (e: DragEvent) => { e.preventDefault(); el.classList.add("ring-2", "ring-violet-500"); };
    const onDragLeave = () => el.classList.remove("ring-2", "ring-violet-500");
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      el.classList.remove("ring-2", "ring-violet-500");
      handleFiles(e.dataTransfer?.files || null);
    };
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("dragleave", onDragLeave);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("dragleave", onDragLeave);
      el.removeEventListener("drop", onDrop);
    };
  }, [handleFiles]);

  /* ── notification permission on mount ── */
  useEffect(() => {
    ensureNotificationPermission();
  }, []);

  /* ── alarm scheduler ── */
  useEffect(() => {
    const interval = setInterval(() => {
      setNotes((prev) => {
        let changed = false;
        const next = prev.map((n) => {
          if (n.alarmFired || n.completed || !n.reminderTime) return n;
          const alarmAt = new Date(n.reminderTime).getTime();
          if (isNaN(alarmAt)) return n;
          if (Date.now() >= alarmAt) {
            changed = true;
            fireNotification(n);
            return { ...n, alarmFired: true };
          }
          return n;
        });
        return changed ? next : prev;
      });
    }, 15_000); // check every 15 seconds

    return () => clearInterval(interval);
  }, [setNotes]);

  const filteredNotes = useMemo(() => {
    return notes.filter((n) => {
      if (!showCompleted && n.completed) return false;
      if (filterType !== "all" && n.type !== filterType) return false;
      if (query) {
        const q = query.toLowerCase();
        return (
          n.content.toLowerCase().includes(q) ||
          n.tags.some((t) => t.toLowerCase().includes(q))
        );
      }
      return true;
    });
  }, [notes, filterType, query, showCompleted]);

  const stats = useMemo(() => {
    const tasks = notes.filter((n) => n.type === "task" && !n.completed).length;
    const reminders = notes.filter((n) => n.type === "reminder" && !n.completed).length;
    const done = notes.filter((n) => n.completed).length;
    const alarms = notes.filter((n) => n.reminderTime && !n.alarmFired && !n.completed).length;
    return { tasks, reminders, done, alarms, total: notes.length };
  }, [notes]);

  const addManualNote = () => {
    const content = prompt("Enter note, task, or reminder");
    if (!content) return;
    const note: Note = {
      id: uid(),
      screenshotId: null,
      content,
      type: "note",
      dueDate: null,
      reminderTime: null,
      alarmFired: false,
      completed: false,
      important: false,
      tags: [],
      createdAt: Date.now(),
    };
    setNotes((n) => [note, ...n]);
    showToast("📝 Note added");
  };

  const exportData = () => {
    const data = { screenshots, notes, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `screen-notes-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("📦 Data exported");
  };

  const updateNote = (id: string, patch: Partial<Note>) => {
    setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, ...patch } : n)));
  };

  /* ── set alarm on a note ── */
  const setAlarm = (note: Note) => {
    const defaultVal = note.reminderTime || toLocalDatetimeString(new Date(Date.now() + 10 * 60_000));
    const val = prompt("Set alarm date & time (YYYY-MM-DDTHH:MM):", defaultVal);
    if (!val) return;
    const parsed = new Date(val);
    if (isNaN(parsed.getTime())) {
      showToast("❌ Invalid date/time");
      return;
    }
    if (parsed.getTime() <= Date.now()) {
      showToast("⚠️ Time must be in the future");
      return;
    }
    updateNote(note.id, { reminderTime: parsed.toISOString(), alarmFired: false });
    ensureNotificationPermission();
    showToast(`🔔 Alarm set for ${parsed.toLocaleString()}`);
  };

  const removeAlarm = (noteId: string) => {
    updateNote(noteId, { reminderTime: null, alarmFired: false });
    showToast("🔕 Alarm removed");
  };

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-zinc-100 selection:bg-violet-500/30">
      {/* Background */}
      <div className="pointer-events-none fixed inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_-10%,rgba(139,92,246,0.25),transparent_60%),radial-gradient(40%_40%_at_100%_0%,rgba(56,189,248,0.15),transparent_50%),radial-gradient(40%_40%_at_0%_100%,rgba(236,72,153,0.12),transparent_50%)]" />
        <div className="absolute inset-0 opacity-[0.04] mix-blend-soft-light" style={{ backgroundImage: `repeating-linear-gradient(0deg, #fff 0px, #fff 1px, transparent 1px, transparent 24px),repeating-linear-gradient(90deg, #fff 0px, #fff 1px, transparent 1px, transparent 24px)` }} />
      </div>

      {/* Toast */}
      {toastMsg && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 animate-bounce rounded-2xl border border-white/10 bg-black/80 px-5 py-3 text-sm text-zinc-200 backdrop-blur-2xl shadow-2xl">
          {toastMsg}
        </div>
      )}

      <div className="relative mx-auto max-w-[1400px] px-4 py-6 md:px-8 md:py-8">
        {/* Header */}
        <header className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow-lg shadow-violet-500/25">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-white">
                <path d="M4 8V6a2 2 0 0 1 2-2h2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path d="M4 16v2a2 2 0 0 0 2 2h2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path d="M16 4h2a2 2 0 0 1 2 2v2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path d="M16 20h2a2 2 0 0 0 2-2v-2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <rect x="7" y="9" width="10" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
              </svg>
            </div>
            <div>
              <h1 className="text-[22px] font-semibold tracking-tight">ScreenNote</h1>
              <p className="text-xs text-zinc-400 -mt-0.5">Turn screenshots into actionable notes & reminders</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="rounded-full bg-white/10 px-4 py-1.5 text-sm font-medium text-white">
              Workspace
            </span>
          </div>
        </header>

        <div className="mt-8 grid grid-cols-12 gap-6">
          {/* ── Left sidebar ── */}
          <aside className="col-span-12 lg:col-span-3 space-y-4">
            <div
              ref={dropRef}
              className="group relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.04] p-4 backdrop-blur-xl transition hover:border-white/20"
            >
              <div className="absolute inset-0 bg-gradient-to-b from-violet-500/10 to-transparent opacity-0 transition group-hover:opacity-100" />
              <div className="relative">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-zinc-200">Capture</h2>
                  <span className="text-[10px] uppercase tracking-wider text-zinc-500">OCR • Local</span>
                </div>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] py-6 text-sm text-zinc-300 transition hover:border-violet-500/50 hover:bg-violet-500/10 hover:text-white"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                  </svg>
                  Drop screenshots or click
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => handleFiles(e.target.files)}
                />
                <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                  Works 100% in your browser. No uploads to server. Tesseract.js extracts text instantly.
                </p>
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-4 gap-2">
              {[
                { label: "Tasks", val: stats.tasks, color: "from-amber-500 to-orange-500" },
                { label: "Remind", val: stats.reminders, color: "from-sky-500 to-cyan-500" },
                { label: "Alarms", val: stats.alarms, color: "from-rose-500 to-pink-500" },
                { label: "Done", val: stats.done, color: "from-emerald-500 to-teal-500" },
              ].map((s) => (
                <div key={s.label} className="rounded-2xl border border-white/10 bg-white/[0.04] p-2.5 backdrop-blur">
                  <div className={`bg-gradient-to-br ${s.color} bg-clip-text text-lg font-semibold text-transparent`}>
                    {s.val}
                  </div>
                  <div className="text-[10px] uppercase tracking-wide text-zinc-500">{s.label}</div>
                </div>
              ))}
            </div>

            {/* Screenshots list */}
            <div className="rounded-3xl border border-white/10 bg-white/[0.04] backdrop-blur-xl">
              <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                <h3 className="text-sm font-semibold text-zinc-200">Screenshots</h3>
                <span className="text-xs text-zinc-500">{screenshots.length}</span>
              </div>
              <div className="max-h-[400px] space-y-2 overflow-y-auto p-2">
                {screenshots.length === 0 && (
                  <div className="px-3 py-8 text-center text-sm text-zinc-500">
                    No screenshots yet. Upload one to start.
                  </div>
                )}
                {screenshots.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSelectedShotId(s.id)}
                    className={`group flex w-full items-center gap-3 rounded-2xl border p-2 text-left transition ${selectedShotId === s.id
                        ? "border-violet-500/50 bg-violet-500/10"
                        : "border-transparent hover:border-white/10 hover:bg-white/[0.04]"
                      }`}
                  >
                    <div className="relative h-14 w-14 overflow-hidden rounded-xl bg-zinc-900">
                      <img src={s.dataUrl} alt="" className="h-full w-full object-cover" />
                      {s.status === "processing" && (
                        <div className="absolute inset-0 grid place-items-center bg-black/60 text-[10px] font-medium">
                          {s.progress}%
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-zinc-200">{s.name}</div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <span className={`h-1.5 w-1.5 rounded-full ${s.status === "done" ? "bg-emerald-500" :
                            s.status === "processing" ? "bg-amber-500 animate-pulse" :
                              s.status === "error" ? "bg-red-500" : "bg-zinc-600"
                          }`} />
                        <span className="text-[11px] capitalize text-zinc-500">{s.status}</span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </aside>

          {/* ── Center: Notes ── */}
          <main className="col-span-12 lg:col-span-6">
            <div className="rounded-[28px] border border-white/10 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-1 backdrop-blur-2xl">
              <div className="rounded-[24px] bg-[#0b0b12]/80 p-5">
                {/* Toolbar */}
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative flex-1 min-w-[200px]">
                    <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search notes, tags..."
                      className="w-full rounded-xl border border-white/10 bg-white/[0.04] py-2 pl-9 pr-3 text-sm outline-none placeholder:text-zinc-600 focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/20"
                    />
                  </div>
                  <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.04] p-1">
                    {(["all", "task", "reminder", "note"] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => setFilterType(t)}
                        className={`rounded-lg px-2.5 py-1 text-xs font-medium capitalize transition ${filterType === t ? "bg-white/10 text-white" : "text-zinc-400 hover:text-zinc-200"
                          }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => setShowCompleted((v) => !v)}
                    className={`rounded-xl border px-3 py-2 text-xs font-medium transition ${showCompleted
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                        : "border-white/10 bg-white/[0.04] text-zinc-400 hover:text-zinc-200"
                      }`}
                  >
                    {showCompleted ? "Hide done" : "Show done"}
                  </button>
                </div>

                {/* Actions */}
                <div className="mt-4 flex items-center justify-between">
                  <h2 className="text-[15px] font-semibold text-zinc-100">Extracted Insights</h2>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={addManualNote}
                      className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-white/15"
                    >
                      + New note
                    </button>
                    <button
                      onClick={exportData}
                      className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-white/20 hover:text-white"
                    >
                      Export
                    </button>
                  </div>
                </div>

                {/* Notes list */}
                <div className="mt-4 space-y-2.5 max-h-[620px] overflow-y-auto pr-1">
                  {filteredNotes.length === 0 && (
                    <div className="rounded-2xl border border-dashed border-white/10 py-16 text-center">
                      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/5">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-600"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 9h10M7 13h6" /></svg>
                      </div>
                      <p className="text-sm text-zinc-400">No notes yet. Upload a screenshot to extract tasks.</p>
                    </div>
                  )}
                  {filteredNotes.map((n) => (
                    <div
                      key={n.id}
                      className={`group relative rounded-2xl border p-4 transition ${n.completed
                          ? "border-white/5 bg-white/[0.02] opacity-60"
                          : "border-white/10 bg-gradient-to-b from-white/[0.06] to-white/[0.03] hover:border-white/20"
                        } ${n.reminderTime && !n.alarmFired && !n.completed ? "ring-1 ring-rose-500/30" : ""}`}
                    >
                      <div className="flex items-start gap-3">
                        {/* Checkbox */}
                        <button
                          onClick={() => updateNote(n.id, { completed: !n.completed })}
                          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition ${n.completed
                              ? "border-emerald-500 bg-emerald-500"
                              : "border-zinc-700 hover:border-violet-500"
                            }`}
                        >
                          {n.completed && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round"><path d="M5 13l4 4L19 7" /></svg>}
                        </button>

                        <div className="min-w-0 flex-1">
                          {/* Badges */}
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${n.type === "task" ? "bg-amber-500/15 text-amber-300 border border-amber-500/20" :
                                n.type === "reminder" ? "bg-sky-500/15 text-sky-300 border border-sky-500/20" :
                                  "bg-zinc-700/50 text-zinc-300 border border-zinc-700"
                              }`}>
                              {n.type}
                            </span>
                            {n.important && (
                              <span className="rounded-full bg-rose-500/15 border border-rose-500/20 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-rose-300">
                                Important
                              </span>
                            )}
                            {n.dueDate && (
                              <span className="text-[11px] text-zinc-500">Due {n.dueDate}</span>
                            )}
                            {n.reminderTime && !n.completed && (
                              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${n.alarmFired
                                  ? "bg-zinc-700/50 text-zinc-500"
                                  : "bg-rose-500/15 text-rose-300"
                                }`}>
                                {n.alarmFired ? "🔕 Fired" : `🔔 ${new Date(n.reminderTime).toLocaleString()}`}
                              </span>
                            )}
                          </div>

                          {/* Content */}
                          <p className={`mt-1.5 text-[14px] leading-relaxed ${n.completed ? "line-through text-zinc-500" : "text-zinc-200"}`}>
                            {n.content}
                          </p>

                          {/* Tags & time */}
                          <div className="mt-2 flex items-center gap-3 text-[11px] text-zinc-600">
                            {n.tags.map(t => (
                              <span key={t} className="rounded bg-white/5 px-1.5 py-0.5">#{t}</span>
                            ))}
                            <span className="ml-auto opacity-0 transition group-hover:opacity-100">
                              {new Date(n.createdAt).toLocaleString()}
                            </span>
                          </div>
                        </div>

                        {/* Action buttons */}
                        <div className="flex flex-col items-center gap-1 opacity-0 transition group-hover:opacity-100">
                          {/* Share */}
                          <button
                            onClick={async () => {
                              const result = await shareNote(n);
                              if (result === "copied") showToast("📋 Share link copied to clipboard!");
                              else showToast("🔗 Note shared!");
                            }}
                            className="rounded-lg p-1.5 text-zinc-500 hover:bg-sky-500/10 hover:text-sky-300"
                            title="Share via link"
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98" /></svg>
                          </button>

                          {/* Set alarm (for reminders or any note) */}
                          {!n.reminderTime ? (
                            <button
                              onClick={() => setAlarm(n)}
                              className="rounded-lg p-1.5 text-zinc-500 hover:bg-rose-500/10 hover:text-rose-300"
                              title="Set alarm"
                            >
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="13" r="7" /><path d="M12 9v4l2.5 1.5" /><path d="M5 4 2 7M19 4l3 3" /></svg>
                            </button>
                          ) : (
                            <button
                              onClick={() => removeAlarm(n.id)}
                              className="rounded-lg p-1.5 text-rose-400 hover:bg-rose-500/10"
                              title="Remove alarm"
                            >
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="13" r="7" /><path d="M5 4 2 7M19 4l3 3M9 13l3 3 3-3" /></svg>
                            </button>
                          )}

                          {/* Edit */}
                          <button
                            onClick={() => {
                              const content = prompt("Edit note", n.content);
                              if (content) updateNote(n.id, { content });
                            }}
                            className="rounded-lg p-1.5 text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
                            title="Edit"
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>
                          </button>

                          {/* Delete */}
                          <button
                            onClick={() => setNotes(ns => ns.filter(x => x.id !== n.id))}
                            className="rounded-lg p-1.5 text-zinc-500 hover:bg-rose-500/10 hover:text-rose-300"
                            title="Delete"
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2m-1 0v14a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V6" /></svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </main>

          {/* ── Right: Preview ── */}
          <aside className="col-span-12 lg:col-span-3 space-y-4">
            <div className="rounded-3xl border border-white/10 bg-white/[0.04] backdrop-blur-xl">
              <div className="border-b border-white/10 px-4 py-3">
                <h3 className="text-sm font-semibold text-zinc-200">Preview</h3>
              </div>
              <div className="p-4">
                {selectedShot ? (
                  <div className="space-y-3">
                    <div className="overflow-hidden rounded-2xl border border-white/10 bg-black">
                      <img src={selectedShot.dataUrl} alt="" className="w-full" />
                    </div>
                    <div>
                      <h4 className="text-xs uppercase tracking-wide text-zinc-500">Extracted Text</h4>
                      <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-2xl border border-white/10 bg-black/40 p-3 text-xs leading-relaxed text-zinc-300">
                        {selectedShot.text || "Processing..."}
                      </pre>
                    </div>
                  </div>
                ) : (
                  <div className="py-12 text-center text-sm text-zinc-500">
                    Select a screenshot to preview
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-violet-600/20 to-fuchsia-600/20 p-4 backdrop-blur-xl">
              <h4 className="text-sm font-semibold text-white">Share & Alarms</h4>
              <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-violet-100/80">
                <li>🔗 <strong>Share</strong> — Hover any note and click the share icon to copy a link or use native share.</li>
                <li>🔔 <strong>Alarm</strong> — Click the bell to set a date/time. You'll get a browser notification + sound!</li>
                <li>💡 Reminders auto-detect dates from screenshots. Set alarms on any note.</li>
              </ul>
            </div>
          </aside>
        </div>

        <footer className="mt-12 border-t border-white/10 py-6 text-center text-xs text-zinc-600">
          ScreenNote • Built with Tesseract.js • Runs locally • Share via URL • Alarms with notifications
        </footer>
      </div>
    </div>
  );
}


