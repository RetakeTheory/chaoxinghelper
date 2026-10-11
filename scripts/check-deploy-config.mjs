import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"));
const db = config.d1_databases?.find(binding => binding.binding === "DB");
if (!db?.database_id || db.database_id === "00000000-0000-0000-0000-000000000000") throw new Error("请先创建自己的 D1 数据库并填写 database_id，再构建和部署。");
for (const [name, className] of [["ONEBOT", "OneBotSession"], ["CHAOXING_WEB", "ChaoxingWebSession"]]) {
  if (!config.durable_objects?.bindings?.some(binding => binding.name === name && binding.class_name === className)) throw new Error(`缺少 ${name} 绑定`);
  if (!config.migrations?.some(migration => migration.new_sqlite_classes?.includes(className))) throw new Error(`缺少 ${className} 迁移`);
}
if (!config.r2_buckets?.some(binding => binding.binding === "ONEBOT_REMINDERS")) throw new Error("缺少提醒 R2 存储绑定");
console.log("部署配置检查通过。");
