function minutes(time) {
  const [hours, mins] = time.split(':').map(Number);
  return hours * 60 + mins;
}

function overlaps(first, second) {
  return minutes(first.startTime) < minutes(second.endTime)
    && minutes(second.startTime) < minutes(first.endTime);
}

module.exports = { overlaps };
