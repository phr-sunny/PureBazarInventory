const mongoose = require('mongoose');

const workShiftSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  startTime: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  endTime: {
    type: String,
    required: true,
    match: /^([01]\d|2[0-3]):[0-5]\d$/,
    validate: {
      validator(value) { return !this.startTime || value > this.startTime; },
      message: 'End time must be later than start time',
    },
  },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', required: true },
  isActive: { type: Boolean, default: true, required: true },
}, { timestamps: true });

workShiftSchema.index({ locationId: 1, name: 1 }, { unique: true });

module.exports = mongoose.models.WorkShift || mongoose.model('WorkShift', workShiftSchema);
