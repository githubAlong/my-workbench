import test from "node:test";
import assert from "node:assert/strict";
import { getCanonicalPeriodNumber, cleanPeriodTime, normalizeTimetablePeriods, completeTimetablePeriods } from "../js/timetable-periods.mjs";

test("Arabic and Chinese lesson labels resolve to one canonical period number", () => {
  assert.equal(getCanonicalPeriodNumber({ period_no: "第1节", name: "第1节" }), 1);
  assert.equal(getCanonicalPeriodNumber({ period_no: "第一节", name: "第一节" }), 1);
  assert.equal(getCanonicalPeriodNumber({ period_no: 3, name: "第三节" }), 3);
  assert.equal(getCanonicalPeriodNumber({ name: "晚自习一" }), 10);
  assert.equal(getCanonicalPeriodNumber({ name: "晚自习第二节", period_no: 12 }), 11);
  assert.equal(getCanonicalPeriodNumber({ name: "午休" }), 5.5);
});

test("duplicate period rows merge and prefer valid time ranges", () => {
  const rows = normalizeTimetablePeriods([
    { id: "bad-1", period_no: "第1节", name: "第1节", start_time: "00:00", end_time: "00:00" },
    { id: "good-1", period_no: 1, name: "第一节", start_time: "08:00", end_time: "08:40" },
    { id: "2", period_no: 2, name: "第二节", start_time: "08:50", end_time: "09:30" },
    { id: "bad-3", period_no: "第3节", name: "第3节", start_time: "00:00", end_time: "00:00" },
    { id: "good-3", period_no: 3, name: "第三节", start_time: "10:00", end_time: "10:40" },
    { id: "4", period_no: 4, name: "第四节", start_time: "10:50", end_time: "11:30" },
    { id: "5", period_no: 5, name: "第五节", start_time: "00:00", end_time: "00:00" },
  ]);
  assert.deepEqual(rows.map((row) => row.period_no), [1, 2, 3, 4, 5]);
  assert.deepEqual(rows.map((row) => row.name), ["第1节", "第2节", "第3节", "第4节", "第5节"]);
  assert.equal(rows[0].start_time, "08:00");
  assert.equal(rows[0].end_time, "08:40");
  assert.equal(rows[2].start_time, "10:00");
  assert.equal(rows[2].end_time, "10:40");
  assert.equal(rows[4].start_time, "");
  assert.equal(rows[4].end_time, "");
});

test("course time corrects a conflicting legacy period number", () => {
  assert.equal(getCanonicalPeriodNumber({
    period_no: 10, name: "第10节", start_time: "08:00", end_time: "08:40",
  }), 1);
  assert.equal(getCanonicalPeriodNumber({
    period_no: 11, name: "第11节", start_time: "19:30", end_time: "20:10",
  }), 11);
  assert.equal(getCanonicalPeriodNumber({
    period_no: 14, name: "第14节", start_time: "", end_time: "",
  }), 14);
  assert.equal(getCanonicalPeriodNumber({
    period_no: 15, name: "第15节", start_time: "", end_time: "",
  }), 15);
});

test("duplicate morning aliases merge while distinct evening periods keep their numbers and times", () => {
  const rows = normalizeTimetablePeriods([
    { id: "first-wrong", period_no: 10, name: "第10节", start_time: "08:00", end_time: "08:40" },
    { id: "first-correct", period_no: 1, name: "第一节", start_time: "08:00", end_time: "08:40" },
    { id: "night-11", period_no: 11, name: "第11节", start_time: "19:30", end_time: "20:10" },
    { id: "night-12", period_no: 12, name: "第12节", start_time: "20:20", end_time: "21:00" },
    { id: "night-13", period_no: 13, name: "第13节", start_time: "21:10", end_time: "21:55" },
    { id: "night-14", period_no: 14, name: "第14节", start_time: "", end_time: "" },
    { id: "night-15", period_no: 15, name: "第15节", start_time: "", end_time: "" },
  ]);
  assert.deepEqual(rows.map((row) => row.period_no), [1, 11, 12, 13, 14, 15]);
  assert.equal(rows[0].name, "第1节");
  assert.equal(rows[1].name, "晚二");
  assert.equal(rows[1].start_time, "19:30");
  assert.equal(rows[1].end_time, "20:10");
  assert.equal(rows[2].start_time, "20:20");
  assert.equal(rows[3].end_time, "21:55");
});

test('configured lunch and evening courses remain visible without changing stored records', () => {
  const periods=[{period_no:1,name:'第一节'},{period_no:5.5,name:'午休'},{period_no:10,name:'晚一'}];
  const courses=[{period_no:11,name:'晚二',start_time:'19:30',end_time:'20:10'},
    {period_no:13,name:'晚四',start_time:'21:10',end_time:'21:55'},{period_no:14,start_time:'',end_time:''}];
  const original=JSON.stringify({periods,courses});
  const result=completeTimetablePeriods(periods,courses);
  assert.deepEqual(result.map(row=>row.period_no),[1,5.5,10,11,13,14]);
  assert.equal(result.find(row=>row.period_no===13).end_time,'21:55');
  assert.equal(JSON.stringify({periods,courses}),original);
  assert.equal(completeTimetablePeriods(result,courses).length,result.length);
});

test("00:00 placeholders are treated as missing times, not real lesson times", () => {
  assert.equal(cleanPeriodTime("00:00"), "");
  assert.equal(cleanPeriodTime("8:00"), "08:00");
  assert.equal(cleanPeriodTime("08:40"), "08:40");
});
