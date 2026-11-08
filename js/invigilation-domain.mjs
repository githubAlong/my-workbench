const META_PREFIX = 'WB_INVIG_SETTLEMENT_V1:';

export function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function cleanPayments(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    id: String(item && item.id != null ? item.id : ''),
    amount: roundMoney(item && item.amount),
    paid_at: String(item && (item.paid_at || item.date) || ''),
    method: String(item && item.method || ''),
    note: String(item && item.note || ''),
  })).filter((item) => item.amount > 0);
}

export function parseSettlementMeta(value) {
  const raw = String(value || '');
  if (!raw.startsWith(META_PREFIX)) {
    return { structured: false, note: raw, payments: [] };
  }
  try {
    const parsed = JSON.parse(raw.slice(META_PREFIX.length));
    return {
      structured: true,
      note: String(parsed && parsed.note || ''),
      payments: cleanPayments(parsed && parsed.payments),
    };
  } catch {
    return { structured: false, note: raw, payments: [] };
  }
}

export function serializeSettlementMeta(note, payments) {
  const list = cleanPayments(payments);
  if (!list.length) return String(note || '');
  return META_PREFIX + JSON.stringify({
    version: 1,
    note: String(note || ''),
    payments: list,
  });
}

export function settlementOf(row = {}) {
  const total = roundMoney(row.pay_amount != null ? row.pay_amount : row.amount);
  const meta = parseSettlementMeta(row.pay_note);
  const isSchool = (row.duty_type || 'school') === 'school';
  const legacySettled = isSchool ? Number(row.school_paid || row.paid) === 1 : !!row.settled_at;
  const legacyPaid = !meta.structured && legacySettled ? total : 0;
  const transactionPaid = meta.payments.reduce((sum, item) => sum + item.amount, 0);
  const paid = roundMoney(Math.min(Math.max(total, 0), meta.structured ? transactionPaid : legacyPaid));
  const remaining = roundMoney(Math.max(0, total - paid));
  let status = 'unpriced';
  if (total > 0) status = remaining <= 0.009 ? 'done' : paid > 0 ? 'partial' : 'unpaid';
  return {
    total,
    paid,
    remaining,
    status,
    payments: meta.payments,
    note: meta.note,
    structured: meta.structured,
    legacy: !meta.structured && legacySettled && total > 0,
  };
}

function paymentListFor(row) {
  const meta = parseSettlementMeta(row && row.pay_note);
  return { meta, payments: meta.payments.slice() };
}

function latestPaymentDate(payments) {
  return payments.reduce((latest, item) => {
    const value = String(item.paid_at || '');
    return value > latest ? value : latest;
  }, '');
}

export function addPaymentPatch(row, payment) {
  const state = settlementOf(row);
  const amount = roundMoney(payment && payment.amount);
  if (state.total <= 0) throw new Error('请先填写本场应结金额');
  if (amount <= 0) throw new Error('本次收付金额必须大于 0');
  if (amount > state.remaining + 0.009) throw new Error('本次金额不能超过剩余未结金额');

  const current = paymentListFor(row);
  const nextPayments = current.payments.concat([{
    id: String(payment && payment.id || ''),
    amount,
    paid_at: String(payment && payment.paid_at || new Date().toISOString()),
    method: String(payment && payment.method || ''),
    note: String(payment && payment.note || ''),
  }]);
  const pay_note = serializeSettlementMeta(current.meta.note, nextPayments);
  const paid = roundMoney(nextPayments.reduce((sum, item) => sum + item.amount, 0));
  const fullySettled = paid + 0.009 >= state.total;
  const isSchool = (row.duty_type || 'school') === 'school';
  const patch = { pay_note };

  if (isSchool) {
    patch.school_paid = fullySettled ? 1 : 0;
    patch.paid = fullySettled ? 1 : 0;
  } else {
    patch.settled_at = fullySettled ? latestPaymentDate(nextPayments) || new Date().toISOString() : null;
    patch.settle_key = fullySettled
      ? String(row.peer_name || row.person || '') + '|' + String(row.date || '').slice(0, 7)
      : '';
  }
  return patch;
}

export function removePaymentPatch(row, paymentId) {
  const current = paymentListFor(row);
  if (!current.meta.structured) throw new Error('这条记录没有逐笔收付明细');
  const nextPayments = current.payments.filter((item) => item.id !== String(paymentId));
  if (nextPayments.length === current.payments.length) throw new Error('找不到这笔收付记录');

  const pay_note = serializeSettlementMeta(current.meta.note, nextPayments);
  const total = roundMoney(row.pay_amount != null ? row.pay_amount : row.amount);
  const paid = roundMoney(nextPayments.reduce((sum, item) => sum + item.amount, 0));
  const fullySettled = total > 0 && paid + 0.009 >= total;
  const isSchool = (row.duty_type || 'school') === 'school';
  const patch = { pay_note };

  if (isSchool) {
    patch.school_paid = fullySettled ? 1 : 0;
    patch.paid = fullySettled ? 1 : 0;
  } else {
    patch.settled_at = fullySettled ? latestPaymentDate(nextPayments) || new Date().toISOString() : null;
    patch.settle_key = fullySettled
      ? String(row.peer_name || row.person || '') + '|' + String(row.date || '').slice(0, 7)
      : '';
  }
  return patch;
}

export function undoLegacySettlementPatch() {
  return {
    school_paid: 0,
    paid: 0,
    settled_at: null,
    settle_key: '',
  };
}

export function calcDurationMinutes(startTime, endTime) {
  const a = /^(\d{1,2}):(\d{2})$/.exec(String(startTime || ''));
  const b = /^(\d{1,2}):(\d{2})$/.exec(String(endTime || ''));
  if (!a || !b) return null;
  const start = Number(a[1]) * 60 + Number(a[2]);
  const end = Number(b[1]) * 60 + Number(b[2]);
  let duration = end - start;
  if (duration < 0) duration += 24 * 60;
  return duration;
}

export function calcInvigAmount(dutyType, durationMinutes, rules = {}) {
  if (dutyType !== 'school') return roundMoney(rules.peerPerSession == null ? 50 : rules.peerPerSession);
  const mode = rules.mode || '分钟';
  const minutes = Math.max(0, Number(durationMinutes) || 0);
  if (mode === '分钟') {
    const rate = rules.perMinute == null ? 0.4 : Number(rules.perMinute);
    return roundMoney(minutes * (Number.isFinite(rate) ? rate : 0));
  }
  if (mode === '时长') {
    const tiers = Array.isArray(rules.tiers) && rules.tiers.length
      ? rules.tiers
      : [{ max: 90, amount: 50 }, { max: 150, amount: 70 }, { max: 999, amount: 90 }];
    for (const tier of tiers) {
      if (minutes <= Number(tier.max)) return roundMoney(tier.amount);
    }
    return roundMoney(tiers[tiers.length - 1].amount);
  }
  return roundMoney(rules.perSession == null ? 60 : rules.perSession);
}

export function buildInvigSummary(rows = [], rules = {}) {
  const out = {
    total: 0,
    school: { count: 0, amount: 0, paid: 0, unpaid: 0, paid_count: 0, partial_count: 0 },
    sub_out: { count: 0, hours: 0, amount: 0, paid_amount: 0, open_amount: 0 },
    sub_in: { count: 0, hours: 0, amount: 0, paid_amount: 0, open_amount: 0 },
    net: { amount: 0, direction: 'even' },
    people: [],
    by_room: {},
    minutes: 0,
    rules,
  };
  const peopleMap = new Map();

  for (const row of rows) {
    if ((row.status || 'done') === 'canceled') continue;
    const amount = roundMoney(row.pay_amount != null ? row.pay_amount : row.amount);
    const state = settlementOf(row);
    const type = row.duty_type || 'school';
    out.total += 1;
    out.minutes += Number(row.duration_min != null ? row.duration_min : row.minutes) || 0;
    if (row.room || row.place) {
      const room = String(row.room || row.place);
      out.by_room[room] = (out.by_room[room] || 0) + 1;
    }

    if (type === 'school') {
      out.school.count += 1;
      out.school.amount += amount;
      out.school.paid += state.paid;
      out.school.unpaid += state.remaining;
      if (state.status === 'done') out.school.paid_count += 1;
      if (state.status === 'partial') out.school.partial_count += 1;
      continue;
    }

    const isReceivable = type === '替他人';
    const bucket = isReceivable ? out.sub_out : out.sub_in;
    bucket.count += 1;
    bucket.hours += 1;
    bucket.amount += amount;
    bucket.paid_amount += state.paid;
    bucket.open_amount += state.remaining;

    const name = String(row.peer_name || row.person || '').trim() || '(未填对方)';
    const direction = isReceivable ? 'out' : 'in';
    const key = name + '|' + direction;
    if (!peopleMap.has(key)) {
      peopleMap.set(key, {
        name,
        direction,
        count: 0,
        amount: 0,
        paid_amount: 0,
        open_amount: 0,
        settled: false,
        partial: false,
        settled_count: 0,
        items: [],
        open_items: [],
      });
    }
    const person = peopleMap.get(key);
    const item = {
      id: row.id,
      date: row.date || '',
      start_time: row.start_time || '',
      exam_name: row.exam_name || row.subject || '',
      subject: row.subject || '',
      room: row.room || row.place || '',
      amount,
      paid_amount: state.paid,
      open_amount: state.remaining,
      status: state.status,
      settlement: state,
      row,
    };
    person.count += 1;
    person.amount += amount;
    person.paid_amount += state.paid;
    person.open_amount += state.remaining;
    person.items.push(item);
    if (state.status === 'done') person.settled_count += 1;
    if (state.remaining > 0) person.open_items.push(item);
  }

  out.school.amount = roundMoney(out.school.amount);
  out.school.paid = roundMoney(out.school.paid);
  out.school.unpaid = roundMoney(out.school.unpaid);
  out.sub_out.amount = roundMoney(out.sub_out.amount);
  out.sub_out.paid_amount = roundMoney(out.sub_out.paid_amount);
  out.sub_out.open_amount = roundMoney(out.sub_out.open_amount);
  out.sub_in.amount = roundMoney(out.sub_in.amount);
  out.sub_in.paid_amount = roundMoney(out.sub_in.paid_amount);
  out.sub_in.open_amount = roundMoney(out.sub_in.open_amount);

  for (const person of peopleMap.values()) {
    person.amount = roundMoney(person.amount);
    person.paid_amount = roundMoney(person.paid_amount);
    person.open_amount = roundMoney(person.open_amount);
    person.settled = person.count > 0 && person.open_amount <= 0.009;
    person.partial = person.paid_amount > 0 && person.open_amount > 0.009;
    person.items.sort((a, b) => String(b.date).localeCompare(String(a.date))
      || String(b.start_time).localeCompare(String(a.start_time)));
    person.open_items.sort((a, b) => String(b.date).localeCompare(String(a.date))
      || String(b.start_time).localeCompare(String(a.start_time)));
    out.people.push(person);
  }
  out.people.sort((a, b) => a.direction === b.direction
    ? b.open_amount - a.open_amount
    : a.direction === 'out' ? -1 : 1);

  const net = out.sub_out.open_amount - out.sub_in.open_amount;
  out.net.amount = roundMoney(net);
  out.net.direction = net > 0.009 ? 'receivable' : net < -0.009 ? 'payable' : 'even';
  return out;
}
