// Minimal in-memory stand-in for a Mongoose model: real documents (so schema
// validation and setters run) kept in an array instead of MongoDB.
const same = (a, b) => String(a) === String(b);

function matches(doc, filter) {
  return Object.entries(filter || {}).every(([key, cond]) => {
    const value = doc[key];
    if (cond && typeof cond === 'object'
      && Object.getPrototypeOf(cond) === Object.prototype) {
      if (cond.$in) return cond.$in.some((item) => same(item, value));
      const actual = value instanceof Date ? value.getTime() : value;
      return Object.entries(cond).every(([operator, expected]) => {
        const target = expected instanceof Date ? expected.getTime() : expected;
        if (operator === '$gte') return actual >= target;
        if (operator === '$gt') return actual > target;
        if (operator === '$lte') return actual <= target;
        if (operator === '$lt') return actual < target;
        return false;
      });
    }
    if (cond === null) return value === null || value === undefined;
    return same(cond, value);
  });
}

function query(items) {
  const promise = Promise.resolve(items);
  promise.sort = () => promise;
  promise.lean = () => Promise.resolve(items.map((doc) => doc.toObject()));
  return promise;
}

function fakeModel(Real, store) {
  const duplicate = (doc) => {
    const unique = {
      Employee: 'employeeCode',
      ExpenseCategory: 'name',
      SalarySheet: 'month',
    }[Real.modelName];
    if (unique && store.some((other) => other[unique] === doc[unique])) {
      return Object.assign(new Error('duplicate key'), { code: 11000 });
    }
    if (Real.modelName === 'Expense' && doc.sourceType === 'SALARY_SHEET'
      && store.some((other) => same(other.sourceId, doc.sourceId))) {
      return Object.assign(new Error('duplicate key'), { code: 11000 });
    }
    if (Real.modelName === 'WorkShift' && store.some((other) => (
      same(other.locationId, doc.locationId) && other.name === doc.name
    ))) return Object.assign(new Error('duplicate key'), { code: 11000 });
    if (Real.modelName === 'RosterEntry' && store.some((other) => (
      same(other.employeeId, doc.employeeId)
      && same(other.date, doc.date)
      && same(other.workShiftId, doc.workShiftId)
    ))) return Object.assign(new Error('duplicate key'), { code: 11000 });
    return null;
  };

  return {
    create: async (data) => {
      const doc = new Real(data);
      await doc.validate();
      const error = duplicate(doc);
      if (error) throw error;
      doc.save = async function save() { await this.validate(); return this; };
      store.push(doc);
      return doc;
    },
    find: (filter) => query(store.filter((doc) => matches(doc, filter))),
    findOne: async (filter) => store.find((doc) => matches(doc, filter)) || null,
    findById: async (id) => store.find((doc) => same(doc._id, id)) || null,
    deleteOne: async (filter) => {
      const index = store.findIndex((doc) => matches(doc, filter));
      if (index >= 0) store.splice(index, 1);
    },
    updateMany: async (filter, update) => {
      const docs = store.filter((doc) => matches(doc, filter));
      docs.forEach((doc) => {
        if (update.$set) Object.entries(update.$set).forEach(([k, v]) => { doc[k] = v; });
        if (update.$unset) Object.keys(update.$unset).forEach((k) => { doc[k] = undefined; });
      });
      return { modifiedCount: docs.length };
    },
  };
}

module.exports = { fakeModel };
