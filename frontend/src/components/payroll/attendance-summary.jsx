export default function AttendanceSummary({ summary, compact = false }) {
  if (!summary) return null;
  const items = [
    ['Rostered', summary.rosteredShifts],
    ['Attended', summary.attended],
    ['Absent', summary.absent],
    ['Late', summary.lateCount],
    ['Worked hours', Number(summary.totalWorkedHours || 0).toFixed(2)],
  ];
  return (
    <div className={compact ? 'text-xs text-slate-600' : 'rounded-md bg-slate-50 p-3'}>
      {!compact && <h3 className="mb-2 text-sm font-semibold text-slate-800">Attendance summary · reference only</h3>}
      <dl className={compact ? 'flex flex-wrap gap-x-3 gap-y-1' : 'grid grid-cols-2 gap-3 text-sm sm:grid-cols-5'}>
        {items.map(([label, value]) => (
          <div key={label}>
            <dt className="text-slate-500">{label}</dt>
            <dd className="m-0 font-medium text-slate-800">{value}</dd>
          </div>
        ))}
      </dl>
      {!compact && <p className="mb-0 mt-2 text-xs text-slate-500">For reference only; attendance does not change salary or deductions.</p>}
    </div>
  );
}
