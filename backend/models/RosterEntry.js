const mongoose = require('mongoose');

const rosterEntrySchema = new mongoose.Schema({
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  workShiftId: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkShift', required: true },
  date: { type: Date, required: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
  notes: { type: String, trim: true, maxlength: 500 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

rosterEntrySchema.index({ employeeId: 1, date: 1, workShiftId: 1 }, { unique: true });
rosterEntrySchema.index({ locationId: 1, date: 1 });
rosterEntrySchema.index({ employeeId: 1, date: 1 });

module.exports = mongoose.models.RosterEntry || mongoose.model('RosterEntry', rosterEntrySchema);
