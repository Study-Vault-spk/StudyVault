
import {DATA_SCHEMA_VERSION,ensureSchemaMeta} from "./_lib.mjs";
export default async function handler(){
  await ensureSchemaMeta();
  return Response.json({
    ok:true,
    aiReady:Boolean(process.env.OPENAI_API_KEY),
    gateway:Boolean(process.env.OPENAI_BASE_URL),
    model:process.env.STUDYVAULT_MODEL||"gpt-5-mini",
    schemaVersion:DATA_SCHEMA_VERSION
  },{headers:{"Cache-Control":"no-store"}});
}
export const config={path:"/api/health",method:"GET"};
