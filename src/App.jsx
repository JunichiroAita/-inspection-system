import React, { useMemo, useState, useEffect } from "react";
import { format, addMonths, startOfMonth, endOfMonth, startOfWeek, endOfWeek, addDays, isSameDay, isToday, isBefore, differenceInCalendarDays } from "date-fns";
import { ja } from "date-fns/locale";
import { CheckCircle2, CalendarDays, Plus, AlertTriangle, Camera, FileDown, House, Building2, Wrench, Bell, X, Loader2 } from "lucide-react";

/**
 * 法定点検管理・登録システム（カレンダーUI｜すべての物件対応）
 * - Gemini風のシンプルUI（Tailwind）
 * - 年間計画自動生成（INSP-01）：物件を「すべて」選択して一括生成可
 * - チェックリスト + 写真 → PDF自動作成（INSP-02）
 * - 期限超過は最上段固定＆赤点滅（INSP-03）
 * - 不適合→是正タスク自動作成＆通知（NEW-INSP-04）
 */

const Severity = { HIGH: "重大", MEDIUM: "中", LOW: "軽" };

const INSPECTION_KINDS = {
  "消防設備": { label: "消防設備", defaultFreq: "yearly" },
  "エレベーター": { label: "エレベーター", defaultFreq: "monthly" },
  "受水槽": { label: "受水槽", defaultFreq: "yearly" },
  "排水管": { label: "排水管", defaultFreq: "yearly" },
  "非常照明": { label: "非常照明", defaultFreq: "yearly" },
};

function dueColor(dueDate) {
  const today = new Date();
  const d = new Date(dueDate);
  const days = differenceInCalendarDays(d, new Date(format(today, 'yyyy-MM-dd')));
  if (days < 0) return "animate-blink text-red-600 border-red-600";
  if (days === 0) return "text-red-600 border-red-600";
  if (days <= 3) return "text-yellow-500 border-yellow-500";
  return "text-blue-500 border-blue-500";
}

const initialProperties = [
  { id: "P-001", name: "サンライト大崎", address: "品川区大崎1-1-1" },
  { id: "P-002", name: "グリーンヒルズ三軒茶屋", address: "世田谷区太子堂2-2-2" },
  { id: "P-003", name: "リバーテラス門前仲町", address: "江東区富岡3-3-3" },
];

const initialVendors = [
  { id: "V-AX", name: "東京防災メンテナンス", skills: ["消防設備", "非常照明"] },
  { id: "V-LF", name: "リフト総合サービス", skills: ["エレベーター"] },
  { id: "V-WT", name: "ウォータープラス", skills: ["受水槽", "排水管"] },
];

const initialUsers = [
  { id: "U-001", name: "山田 太郎" },
  { id: "U-002", name: "佐藤 花子" },
  { id: "U-003", name: "李 小龍" },
];

function nextDatesForYear(baseDate, freq) {
  const dates = [];
  const start = startOfMonth(baseDate);
  if (freq === "monthly") {
    for (let i = 0; i < 12; i++) dates.push(addMonths(start, i));
  } else if (freq === "quarterly") {
    for (let i of [0, 3, 6, 9]) dates.push(addMonths(start, i));
  } else {
    dates.push(addMonths(start, 5)); // 6月
  }
  return dates.map(d => new Date(d.getFullYear(), d.getMonth(), freq === 'monthly' ? 20 : freq === 'quarterly' ? 15 : 30));
}

function classNames(...c){return c.filter(Boolean).join(" ");}

async function generatePDF(report) {
  const { default: jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const margin = 40;
  doc.setFontSize(16);
  doc.text("法定点検報告書", margin, 50);
  doc.setFontSize(10);
  doc.text(`物件: ${report.property.name}`, margin, 70);
  doc.text(`点検種別: ${report.kind}`, margin, 85);
  doc.text(`実施日: ${format(report.completedAt, "yyyy-MM-dd", { locale: ja })}`, margin, 100);
  doc.text(`担当者: ${report.assignee?.name ?? "-"}`, margin, 115);
  doc.setFontSize(12);
  doc.text("チェック結果:", margin, 145);
  let y = 165;
  Object.entries(report.answers).forEach(([k, v]) => { doc.text(`- ${k}: ${v ? "OK" : "不適合"}`, margin, y); y += 16; });
  if (report.nonConformities?.length) {
    y += 10; doc.text("不適合詳細:", margin, y); y += 20;
    report.nonConformities.forEach((nc, idx) => {
      doc.text(`${idx + 1}. 事象: ${nc.note}`, margin, y); y += 16;
      doc.text(`   重要度: ${nc.severity}`, margin, y); y += 16;
    });
  }
  for (let i = 0; i < Math.min(3, report.photos.length); i++) {
    const img = report.photos[i]; const w = 220, h = 140;
    if (y + h + 20 > 800) { doc.addPage(); y = 60; }
    try { doc.addImage(img, "JPEG", margin, y, w, h); } catch {}
    y += h + 20;
  }
  doc.save(`${report.property.name}_${report.kind}_報告書_${format(new Date(), "yyyyMMdd_HHmm")}.pdf`);
}

export default function App() {
  const [month, setMonth] = useState(new Date());
  const [properties] = useState(initialProperties);
  const [vendors] = useState(initialVendors);
  const [users] = useState(initialUsers);
  const [selectedPropertyId, setSelectedPropertyId] = useState('ALL');
  const [selectedKinds, setSelectedKinds] = useState(Object.keys(INSPECTION_KINDS));
  const [events, setEvents] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [activeTask, setActiveTask] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const today = new Date();
    const demo = [
      { id: "T-1001", date: today, dueDate: today, propertyId: "P-001", kind: "エレベーター", assigneeId: "U-001", vendorId: "V-LF", status: "予定" },
      { id: "T-1002", date: addDays(today, -5), dueDate: addDays(today, -1), propertyId: "P-002", kind: "消防設備", assigneeId: "U-002", vendorId: "V-AX", status: "未完" },
      { id: "T-1003", date: addDays(today, 10), dueDate: addDays(today, 10), propertyId: "P-003", kind: "受水槽", assigneeId: "U-003", vendorId: "V-WT", status: "予定" },
    ];
    setEvents(demo);
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      const now = new Date();
      const overdue = events.filter(e => isBefore(new Date(e.dueDate), new Date(format(now, 'yyyy-MM-dd'))) && e.status !== "完了");
      if (overdue.length) setNotifications(n => [{ id: Math.random().toString(36), message: `${overdue.length}件の点検が期限超過しています`, at: new Date(), level: "error" }, ...n].slice(0, 5));
    }, 15000);
    return () => clearInterval(id);
  }, [events]);

  const selectedProperty = useMemo(() => properties.find(p=>p.id===selectedPropertyId), [properties, selectedPropertyId]);

  const generateAnnualPlan = () => {
    const base = new Date();
    const newEvents = [];
    const targetProperties = selectedPropertyId === 'ALL' ? properties : properties.filter(p => p.id === selectedPropertyId);

    targetProperties.forEach((prop) => {
      selectedKinds.forEach((kindKey, kindIdx) => {
        const kind = kindKey;
        const freq = INSPECTION_KINDS[kind].defaultFreq;
        const dates = nextDatesForYear(base, freq);
        dates.forEach((d, idx) => {
          const candidateVendors = vendors.filter(v => v.skills.includes(kind));
          const v = candidateVendors[(idx + kindIdx) % (candidateVendors.length || 1)];
          const assignee = users[(idx + kindIdx) % users.length];
          newEvents.push({
            id: `AP-${prop.id}-${kind}-${format(d, 'yyyyMMdd')}`,
            date: d,
            dueDate: d,
            propertyId: prop.id,
            kind,
            assigneeId: assignee.id,
            vendorId: v?.id,
            status: "予定",
          });
        });
      });
    });

    setEvents(prev => {
      const ids = new Set(prev.map(e=>e.id));
      const merged = [...prev];
      newEvents.forEach(ne=>{ if(!ids.has(ne.id)) merged.push(ne); });
      return merged;
    });
    setNotifications(n => [{ id: Math.random().toString(36), message: "1年分の年間計画を生成しました", at: new Date(), level: "info" }, ...n].slice(0, 5));
  };

  const weeks = useMemo(() => {
    const start = startOfWeek(startOfMonth(month), { weekStartsOn: 0 });
    const end = endOfWeek(endOfMonth(month), { weekStartsOn: 0 });
    const days = []; let cur = start; while (cur <= end) { days.push(cur); cur = addDays(cur, 1); }
    const w = []; for (let i = 0; i < days.length; i += 7) w.push(days.slice(i, i + 7));
    return w;
  }, [month]);

  const filteredEvents = useMemo(() => {
    return events.filter(e => (selectedPropertyId === 'ALL' || e.propertyId === selectedPropertyId) && selectedKinds.includes(e.kind));
  }, [events, selectedPropertyId, selectedKinds]);

  const overdueTasks = useMemo(() => {
    const now = new Date();
    return filteredEvents.filter(e => isBefore(new Date(e.dueDate), new Date(format(now, 'yyyy-MM-dd'))) && e.status !== "完了");
  }, [filteredEvents]);

  const openTask = (task) => {
    const assignee = users.find(u => u.id === task.assigneeId);
    const vendor = vendors.find(v => v.id === task.vendorId);
    const property = properties.find(p => p.id === task.propertyId);
    setActiveTask({ ...task, assignee, vendor, property, answers: {}, photos: [], nonConformities: [] });
  };

  const onUploadPhotos = async (files) => {
    const reads = Array.from(files).slice(0, 6).map(file => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); }));
    const dataUrls = await Promise.all(reads);
    setActiveTask(t => ({ ...t, photos: [...(t?.photos||[]), ...dataUrls] }));
  };

  const submitChecklist = async () => {
    if (!activeTask) return; setSubmitting(true);
    const report = { property: activeTask.property, kind: activeTask.kind, completedAt: new Date(), assignee: activeTask.assignee, answers: activeTask.answers, photos: activeTask.photos, nonConformities: activeTask.nonConformities };
    try {
      await generatePDF(report);
      const severities = { [Severity.HIGH]: 7, [Severity.MEDIUM]: 14, [Severity.LOW]: 30 };
      const correctiveTasks = (activeTask.nonConformities || []).map((nc, i) => ({
        id: `CR-${activeTask.id}-${i+1}`,
        date: new Date(), dueDate: addDays(new Date(), severities[nc.severity]),
        propertyId: activeTask.propertyId, kind: `${activeTask.kind} 是正: ${nc.note}`,
        assigneeId: activeTask.assigneeId, vendorId: activeTask.vendorId,
        status: "是正中", parentId: activeTask.id,
      }));
      setEvents(prev => prev.map(e => e.id === activeTask.id ? { ...e, status: "完了" } : e).concat(correctiveTasks));
      setNotifications(n => [ { id: Math.random().toString(36), message: "報告書を生成して保存しました（PDF）", at: new Date(), level: "success" }, ...(correctiveTasks.length ? [{ id: Math.random().toString(36), message: `${correctiveTasks.length}件の是正タスクを作成しました（期限通知あり）`, at: new Date(), level: "info" }] : []), ...n ].slice(0, 5));
      setActiveTask(null);
    } finally { setSubmitting(false); }
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex">
      <aside className="w-80 border-r border-neutral-800 p-4 space-y-4">
        <div className="flex items-center gap-2 text-neutral-300"><CalendarDays size={18}/><span className="text-sm">法定点検カレンダー</span></div>
        <div className="bg-neutral-900 rounded-2xl p-3 space-y-3 shadow">
          <div className="text-xs text-neutral-400 mb-1">物件</div>
          <select className="w-full bg-neutral-800 rounded-xl p-2 text-sm focus:outline-none" value={selectedPropertyId} onChange={e => setSelectedPropertyId(e.target.value)}>
            <option value="ALL">すべての物件</option>
            {properties.map(p => (<option key={p.id} value={p.id}>{p.name}</option>))}
          </select>
          <div className="flex items-center gap-2 text-xs text-neutral-500"><House size={14}/><span>{selectedPropertyId==='ALL' ? 'すべて' : (properties.find(p=>p.id===selectedPropertyId)?.address)}</span></div>
        </div>
        <div className="bg-neutral-900 rounded-2xl p-3 space-y-2">
          <div className="text-xs text-neutral-400 mb-1">点検種別</div>
          <div className="grid grid-cols-2 gap-2">
            {Object.keys(INSPECTION_KINDS).map(k => (
              <button key={k} onClick={() => setSelectedKinds(prev => prev.includes(k) ? prev.filter(x=>x!==k) : [...prev, k])} className={classNames("text-xs rounded-xl px-2 py-1 border", selectedKinds.includes(k) ? "border-blue-500 text-blue-400" : "border-neutral-700 text-neutral-400 hover:text-neutral-200")}>{k}</button>
            ))}
          </div>
        </div>
        <div className="bg-neutral-900 rounded-2xl p-3 space-y-3">
          <div className="text-xs text-neutral-400">操作</div>
          <button onClick={generateAnnualPlan} className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 transition rounded-xl py-2 text-sm"><Plus size={16}/> 年間計画を作る</button>
          <div className="text-[11px] text-neutral-400">※ 「すべての物件」選択時は全物件に対し一括生成します。</div>
        </div>
        <div className="bg-neutral-900 rounded-2xl p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs text-neutral-400"><Bell size={14}/> 通知</div>
          <div className="space-y-2 max-h-56 overflow-auto pr-1 custom-scroll">
            {notifications.length === 0 && <div className="text-xs text-neutral-500">通知はありません</div>}
            {notifications.map(n => (
              <div key={n.id} className={classNames("text-xs rounded-xl px-3 py-2 border", n.level === 'error' ? 'border-red-600/60 text-red-400' : n.level==='success' ? 'border-emerald-600/60 text-emerald-400' : 'border-neutral-700 text-neutral-300') }>
                <div>{n.message}</div>
                <div className="text-[10px] text-neutral-500">{format(n.at, "M/d HH:mm")}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="bg-neutral-900 rounded-2xl p-3 space-y-2">
          <div className="text-xs text-neutral-400">レジェンド</div>
          <div className="space-y-1 text-[11px]">
            <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-blue-500"></span> 期限余裕</div>
            <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-yellow-500"></span> 期日3~1日前</div>
            <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-red-600"></span> 期日当日</div>
            <div className="flex items-center gap-2 animate-blink"><span className="w-2 h-2 rounded-full bg-red-600"></span> 期限超過（点滅）</div>
          </div>
        </div>
      </aside>

      <main className="flex-1 p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <button className="px-3 py-1.5 rounded-xl bg-neutral-900 border border-neutral-800" onClick={()=>setMonth(addMonths(month, -1))}>←</button>
            <div className="text-lg font-semibold">{format(month, "yyyy年 M月", { locale: ja })}</div>
            <button className="px-3 py-1.5 rounded-xl bg-neutral-900 border border-neutral-800" onClick={()=>setMonth(addMonths(month, 1))}>→</button>
          </div>
          <div className="text-sm text-neutral-400 flex items-center gap-2"><Building2 size={16}/>{selectedPropertyId==='ALL' ? 'すべての物件' : (selectedProperty?.name || '')} / {selectedKinds.join("・")}</div>
        </div>

        {overdueTasks.length > 0 && (
          <div className="mb-4 bg-neutral-900 border border-red-800/60 rounded-2xl p-3">
            <div className="flex items-center gap-2 text-red-400 font-medium mb-2 animate-blink"><AlertTriangle size={16}/>期限超過 {overdueTasks.length} 件</div>
            <div className="grid lg:grid-cols-3 md:grid-cols-2 grid-cols-1 gap-3">
              {overdueTasks.map(t => (
                <TaskCard key={t.id} task={t} users={users} vendors={vendors} onOpen={()=>openTask(t)} />
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-7 gap-2">
          {["日","月","火","水","木","金","土"].map(d => (<div key={d} className="text-center text-xs text-neutral-400 py-1">{d}</div>))}
          {weeks.map((row, i) => (
            <React.Fragment key={i}>
              {row.map((d, j) => (
                <div key={j} className={classNames("min-h-[110px] rounded-2xl border p-2 bg-neutral-900 border-neutral-800 flex flex-col", d.getMonth()!==month.getMonth() && "opacity-40") }>
                  <div className={classNames("text-xs mb-2", isToday(d) ? "text-blue-400 font-semibold" : "text-neutral-400")}>{format(d, "d", { locale: ja })}</div>
                  <div className="space-y-2">
                    {filteredEvents.filter(e => isSameDay(new Date(e.date), d)).map(e => (
                      <button key={e.id} onClick={()=>openTask(e)} className={classNames("w-full text-left text-[11px] rounded-xl px-2 py-1 border", dueColor(e.dueDate))}>
                        <div className="flex items-center justify-between">
                          <span>{e.kind} <span className="opacity-60">({properties.find(p=>p.id===e.propertyId)?.name})</span></span>
                          <span className="opacity-70">{users.find(u=>u.id===e.assigneeId)?.name?.slice(0,6)}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </React.Fragment>
          ))}
        </div>
      </main>

      <section className="w-[420px] border-l border-neutral-800 p-4 overflow-auto">
        {!activeTask ? (
          <div>
            <div className="text-sm text-neutral-400 mb-2">本日のタスク</div>
            <div className="space-y-2">
              {filteredEvents.filter(e=> isSameDay(new Date(e.date), new Date())).map(t => (
                <TaskCard key={t.id} task={t} users={users} vendors={vendors} onOpen={()=>openTask(t)} />
              ))}
              {filteredEvents.filter(e=> isSameDay(new Date(e.date), new Date())).length===0 && (
                <div className="text-xs text-neutral-500">本日のタスクはありません</div>
              )}
            </div>
          </div>
        ) : (
          <TaskDetail task={activeTask} setTask={setActiveTask} submit={submitChecklist} onUploadPhotos={onUploadPhotos} submitting={submitting} />
        )}
      </section>

      <style>{`
        .animate-blink { animation: blink 1.2s step-start infinite; }
        @keyframes blink { 50% { opacity: 0.35; } }
        .custom-scroll::-webkit-scrollbar { width: 8px; }
        .custom-scroll::-webkit-scrollbar-thumb { background: #3f3f46; border-radius: 8px; }
      `}</style>
    </div>
  );
}

function TaskCard({ task, users, vendors, onOpen }){
  const assignee = users.find(u=>u.id===task.assigneeId);
  const vendor = vendors.find(v=>v.id===task.vendorId);
  return (
    <button onClick={onOpen} className="w-full text-left bg-neutral-900 border border-neutral-800 rounded-2xl p-3 hover:border-neutral-700">
      <div className="flex items-center gap-2 text-sm font-medium"><Wrench size={16}/><span>{task.kind}</span></div>
      <div className="text-xs text-neutral-400 mt-1">物件: {task.propertyId}</div>
      <div className="text-xs text-neutral-400 mt-1">期日: <span className={classNames("px-2 py-0.5 rounded-full border", dueColor(task.dueDate))}>{format(new Date(task.dueDate), "M/d")}</span></div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-neutral-400">
        <div>担当: {assignee?.name}</div>
        <div>業者: {vendor?.name}</div>
      </div>
      <div className="mt-1 text-[11px] text-neutral-500">状態: {task.status}</div>
    </button>
  );
}

function TaskDetail({ task, setTask, submit, onUploadPhotos, submitting }){
  const checks = ["外観損傷なし", "動作正常", "表示・ラベル正常", "法定項目確認"];
  const toggleAnswer = (k) => setTask(t => ({ ...t, answers: { ...(t.answers||{}), [k]: !t.answers?.[k] } }));
  const addNC = () => setTask(t => ({ ...t, nonConformities: [ ...(t.nonConformities||[]), { note: "", severity: Severity.LOW } ] }));
  const updateNC = (idx, patch) => setTask(t => ({ ...t, nonConformities: t.nonConformities.map((n,i)=> i===idx ? { ...n, ...patch } : n) }));
  const removeNC = (idx) => setTask(t => ({ ...t, nonConformities: t.nonConformities.filter((_,i)=>i!==idx) }));

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm text-neutral-300">点検提出</div>
        <button onClick={()=>setTask(null)} className="text-neutral-400 hover:text-neutral-200"><X size={18}/></button>
      </div>
      <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-3 space-y-3">
        <div className="text-lg font-semibold">{task.kind}</div>
        <div className="text-xs text-neutral-400">{task.property?.name || task.propertyId} / 期日 {format(new Date(task.dueDate), "yyyy-MM-dd")}</div>
        <div>
          <div className="text-sm mt-2 mb-1">チェックリスト</div>
          <div className="space-y-2">
            {checks.map(c => (
              <label key={c} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={!!task.answers?.[c]} onChange={()=>toggleAnswer(c)} /> {c}
              </label>
            ))}
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between mt-4 mb-2">
            <div className="text-sm">不適合</div>
            <button onClick={addNC} className="text-xs px-2 py-1 rounded-lg border border-neutral-700 hover:border-neutral-500">+ 追加</button>
          </div>
          <div className="space-y-2">
            {(task.nonConformities||[]).map((nc, idx) => (
              <div key={idx} className="rounded-xl border border-neutral-800 p-2 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-neutral-400">重要度</span>
                  <select value={nc.severity} onChange={e=>updateNC(idx,{severity:e.target.value})} className="bg-neutral-800 rounded-lg text-xs p-1">
                    <option value={Severity.HIGH}>重大（7日）</option>
                    <option value={Severity.MEDIUM}>中（14日）</option>
                    <option value={Severity.LOW}>軽（30日）</option>
                  </select>
                  <input value={nc.note} onChange={e=>updateNC(idx,{note:e.target.value})} placeholder="事象のメモ" className="flex-1 bg-neutral-800 rounded-lg text-xs p-1"/>
                  <button onClick={()=>removeNC(idx)} className="text-neutral-500 hover:text-neutral-300 text-xs">削除</button>
                </div>
                <div className="text-[11px] text-neutral-500">承認すると是正タスクが自動作成され、期限前通知/超過は管理者にも通知（写真必須）。</div>
              </div>
            ))}
            {(task.nonConformities||[]).length===0 && (<div className="text-[11px] text-neutral-500">不適合がある場合は「+ 追加」を押してください。</div>)}
          </div>
        </div>
        <div>
          <div className="flex items-center gap-2 mt-4 mb-2"><Camera size={16}/><div className="text-sm">写真（証跡）</div></div>
          <input type="file" accept="image/*" multiple onChange={e=>onUploadPhotos(e.target.files)} className="text-xs" />
          <div className="grid grid-cols-3 gap-2 mt-2">
            {(task.photos||[]).map((src, i)=> (<img key={i} src={src} alt="photo" className="w-full h-24 object-cover rounded-lg border border-neutral-800" />))}
          </div>
        </div>
        <button disabled={submitting} onClick={submit} className="w-full flex items-center justify-center gap-2 mt-4 bg-emerald-600 hover:bg-emerald-500 transition rounded-xl py-2 text-sm disabled:opacity-50">{submitting ? <Loader2 className="animate-spin" size={16}/> : <FileDown size={16}/>} 提出してPDFを作成</button>
        <div className="text-[11px] text-neutral-500">PDFはブラウザからダウンロードされ、実運用では物件フォルダ（例：Gドライブ/S3）に保存してください。</div>
      </div>
    </div>
  );
}
