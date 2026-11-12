const mongoose = require('mongoose');

const roleSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true },
  permissions: { type: [String], default: [] },
  allowedLocationType: { type: String, enum: ['any', 'warehouse', 'outlet'], default: 'any' },
}, { timestamps: true });

roleSchema.index({ createdAt: 1 });

module.exports = mongoose.models.Role || mongoose.model('Role', roleSchema);