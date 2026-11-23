/* 教材页：三张统计卡必须真的能筛出对应资料，未发布的也要列得出来、点得动。 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const work = await readFile(new URL("../js/work.js", import.meta.url), "utf8");
const css = await readFile(new URL("../css/app.css", import.meta.url), "utf8");

const block = work.slice(
  work.indexOf("if (key === 'textbook')"),
  work.indexOf("} else if (key === 'pick')"),
);

test("教材页取到的是 textbook 分支，断言不会落在空字符串上", () => {
  assert.ok(block.length > 500, "textbook 分支没被抓到");
});

test("统计卡兼作筛选器，列表不再只渲染学生可见的资料", () => {
  assert.match(block, /const filter = box\.dataset\.tbFilter \|\| 'all';/);
  assert.match(block, /const shown = filter === 'public' \? pubMats : filter === 'private' \? privMats : mats;/);
  assert.match(block, /shown\.length \? shown\.map\(rowHtml\)/);
  /* 旧写法把列表绑死在 pubMats 上：总数写着 4，一条都列不出来。 */
  assert.doesNotMatch(block, /pubMats\.length \? pubMats\.map/);
});

test("仅自己可见的资料给出「发布」入口，学生可见的才给「收回」", () => {
  assert.match(block, /data-pub="\$\{isPub\(m\) \? 1 : 0\}">\$\{isPub\(m\) \? '收回' : '发布'\}/);
  assert.match(block, /public: wasPub \? 0 : 1/);
});

test("切换筛选只重绘不发请求，选中态记在容器 dataset 上", () => {
  assert.match(block, /box\.dataset\.tbFilter = c\.dataset\.tb; paint\(\);/);
  assert.match(block, /class="card card-pad tb-filter\$\{filter === k \? ' on' : ''\}"/);
});

test("学生短链同步失败不能挡住可见性重绘", () => {
  assert.match(block, /try \{ await syncMaterialSharing\(\); \} catch \(error\) \{ syncError = error; \}/);
  assert.match(block, /toast\(syncError \? done \+ '，但学生短链同步失败：' \+ syncError\.message : done/);
  /* 裸 await 一抛错就跳过后面的 renderStudentModule，页面停在旧状态像没反应。 */
  assert.doesNotMatch(block, /await syncMaterialSharing\(\);\s*\n\s*toast\(wasPub/);
});

test("筛选卡选中态样式落在 app.css", () => {
  assert.match(css, /\.tb-filter \{[^}]*cursor: pointer;/);
  assert.match(css, /\.tb-filter\.on \{[^}]*var\(--primary-weak\)/);
});

test("每行带编辑与删除入口，与课件列表走同一套编辑器和软删除", () => {
  assert.match(block, /data-edit="\$\{m\.id\}"[\s\S]{0,90}icon\('edit', 15\)/);
  assert.match(block, /data-del="\$\{m\.id\}"[\s\S]{0,90}icon\('trash', 15\)/);
  assert.match(block, /materialEditor\(m, m\.category_id, \(\) => renderStudentModule\(box, key\)\)/);
  assert.match(block, /api\.del\('\/materials\/' \+ m\.id\)/);
  assert.match(block, /confirmDialog\(`删除《\$\{m\.title\}》？资料会进回收站/);
});

test("删除后同步学生短链，同步失败也不挡住列表重绘", () => {
  const del = block.slice(block.indexOf("querySelectorAll('[data-del]')"));
  assert.ok(del.length > 100, "没抓到删除处理器");
  assert.match(del, /try \{ await syncMaterialSharing\(\); \} catch \(error\) \{ syncError = error; \}/);
  assert.match(del, /toast\(syncError \? '已删除，但学生短链同步失败：' \+ syncError\.message : '已删除，可在回收站找回'/);
  assert.match(del, /renderStudentModule\(box, key\);/);
  assert.doesNotMatch(del, /await syncMaterialSharing\(\);\s*\n\s*toast\('已删除/);
});
