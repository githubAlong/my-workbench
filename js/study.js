import { registerView } from './ui.js';
import { renderStudyRecords } from './study-records.js';

registerView(async function study(main) {
  await renderStudyRecords(main);
});
