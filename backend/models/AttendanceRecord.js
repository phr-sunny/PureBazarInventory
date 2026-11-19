const mongoose = require('mongoose');

const attendanceRecordSchema = new mongoose.Schema({
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
  rosterEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'RosterEntry' },
  clockIn: { type: Date, required: true },
  clockOut: { type: Date, default: null },
  late: { type: Boolean, default: false, required: true },
  earlyLeave: { type: Boolean, default: false, required: true },
  unscheduled: { type: Boolean, default: false, required: true },
  source: { type: String, enum: ['self', 'manager'], required: true },
  editReason: {
    type: String,
    trim: true,
    maxlength: 500,
    required() { return this.source === 'manager'; },
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

attendanceRecordSchema.index(
  { employeeId: 1 },
  { unique: true, partialFilterExpression: { clockOut: null } },
);
attendanceRecordSchema.index({ locationId: 1, clockIn: 1 });
attendanceRecordSchema.index({ employeeId: 1, clockIn: 1 });
attendanceRecordSchema.index({ rosterEntryId: 1 });

module.exports = mongoose.models.AttendanceRecord
  || mongoose.model('AttendanceRecord', attendanceRecordSchema);
