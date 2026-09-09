
import crypto from "node:crypto";
import {
  reportsStore,summariesStore,json,auth,normalizeReport,
  DATA_SCHEMA_VERSION,ensureSchemaMeta
} from "./_lib.mjs";

const MODEL=process.env.STUDYVAULT_MODEL||"gpt-5.6-luna";

function norm(v){
  return String(v||"").trim().toLowerCase().replace(/\s+/g," ");
}
function examKeyFromReport(r){
  return [
    String(r.semester||""),
    norm(r.fach),
    norm(r.pruefer||""),
    norm(r.form||"")
  ].join("|");
}
function hashKey(v){
  return crypto.createHash("sha256").update(String(v)).digest("hex");
}
function extractOutputText(data){
  if(typeof data?.output_text==="string")return data.output_text;
  for(const item of data?.output||[]){
    if(item?.type!=="message")continue;
    for(const part of item.content||[]){
      if(part?.type==="output_text"&&typeof part.text==="string")return part.text;
    }
  }
  return "";
}
async function allReportsForExam(examKey){
  const {blobs}=await reportsStore.list({prefix:"report/"});
  const out=[];
  for(const b of blobs){
    const raw=await reportsStore.get(b.key,{type:"json"});
    if(!raw)continue;
    const r=normalizeReport(raw);
    if(examKeyFromReport(r)===examKey)out.push(r);
  }
  return out.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
}
function sourceFingerprint(reports){
  return hashKey(reports.map(r=>[
    r.id,r.updatedAt,r.createdAt,r.jahr,r.fach,r.pruefer,r.form,r.themen,r.tipps,r.schwierigkeit
  ].join("~")).join("||"));
}
function yearsMeta(reports){
  const years=reports.map(r=>Number(r.jahr)).filter(Number.isFinite);
  if(!years.length)return {from:null,to:null};
  return {from:Math.min(...years),to:Math.max(...years)};
}

export default async function(req){
  await ensureSchemaMeta();
  const a=await auth(req);
  if(!a)return json({error:"Bitte melde dich erneut an."},401);
  if(req.method!=="POST")return json({error:"Method not allowed"},405);

  let body={};
  try{body=await req.json()}catch{return json({error:"Ungültige Anfrage."},400)}
  const examKey=String(body.examKey||"");
  if(!examKey)return json({error:"Prüfung konnte nicht bestimmt werden."},400);

  const reports=await allReportsForExam(examKey);
  if(!reports.length)return json({error:"Für diese Prüfung gibt es noch keine Berichte."},404);

  const fingerprint=sourceFingerprint(reports);
  const cacheKey="exam/"+hashKey(examKey);

  const cached=await summariesStore.get(cacheKey,{type:"json",consistency:"strong"});
  if(cached?.sourceFingerprint===fingerprint && cached?.summary){
    return json({...cached,fromCache:true});
  }

  // For one report, avoid an AI call and present the report as a minimal summary.
  if(reports.length===1){
    const r=reports[0];
    const minimal={
      schemaVersion:DATA_SCHEMA_VERSION,
      examKey,
      sourceFingerprint:fingerprint,
      reportCount:1,
      years:yearsMeta(reports),
      generatedAt:new Date().toISOString(),
      summary:{
        overview:"Für diese Prüfung liegt bisher ein Erfahrungsbericht vor. Die Zusammenfassung wird aussagekräftiger, sobald weitere Berichte hinzukommen.",
        frequent_topics:[r.fach].filter(Boolean),
        typical_tasks:[],
        difficulty_summary:r.schwierigkeit||"Nicht eindeutig",
        recurring_patterns:[],
        tips:[r.tipps].filter(Boolean).slice(0,3),
        recent_trends:[],
        confidence:"niedrig"
      }
    };
    await summariesStore.setJSON(cacheKey,minimal);
    return json({...minimal,fromCache:false});
  }

  const key=process.env.OPENAI_API_KEY;
  const base=(process.env.OPENAI_BASE_URL||"https://api.openai.com").replace(/\/$/,"");
  if(!key)return json({error:"KI-Zusammenfassungen sind noch nicht konfiguriert."},503);

  const newestYear=Math.max(...reports.map(r=>Number(r.jahr)||0));
  const reportText=reports.map((r,i)=>{
    const age=Math.max(0,newestYear-(Number(r.jahr)||newestYear));
    const recencyWeight=age<=1?"hoch":age<=3?"mittel":"niedrig";
    return `REPORT ${i+1}
Year: ${r.jahr}
Recency weight: ${recencyWeight}
Author: ${r.authorName}
Difficulty: ${r.schwierigkeit}
Topics/tasks:
${r.themen}
Tips/experience:
${r.tipps||"(none)"}`;
  }).join("\n\n---\n\n");

  const developer=`You summarize multiple student reports about the SAME exam.

STRICT RULES:
- Use only information explicitly contained in the supplied reports.
- Never invent exam topics, tasks, difficulty, trends, or advice.
- Aggregate patterns instead of copying individual reports.
- Newer reports matter more than old reports when claims conflict.
- A claim is "frequent" only when it is supported by multiple reports.
- If a pattern is weak or uncertain, say so.
- "recent_trends" may only include changes over time that are actually visible across years.
- Do not imply certainty from a small sample.
- Keep the result concise and useful for a student preparing for this exam.
- Output in German.

Return:
- short overview
- frequent topics
- typical tasks
- difficulty summary
- recurring patterns
- practical tips
- recent trends
- confidence level`;

  const schema={
    type:"object",
    additionalProperties:false,
    properties:{
      overview:{type:"string"},
      frequent_topics:{type:"array",maxItems:10,items:{type:"string"}},
      typical_tasks:{type:"array",maxItems:10,items:{type:"string"}},
      difficulty_summary:{type:"string"},
      recurring_patterns:{type:"array",maxItems:10,items:{type:"string"}},
      tips:{type:"array",maxItems:10,items:{type:"string"}},
      recent_trends:{type:"array",maxItems:8,items:{type:"string"}},
      confidence:{type:"string",enum:["niedrig","mittel","hoch"]}
    },
    required:["overview","frequent_topics","typical_tasks","difficulty_summary","recurring_patterns","tips","recent_trends","confidence"]
  };

  let response;
  try{
    response=await fetch(base+"/v1/responses",{
      method:"POST",
      headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
      body:JSON.stringify({
        model:MODEL,
        reasoning:{effort:"low"},
        input:[
          {role:"developer",content:[{type:"input_text",text:developer}]},
          {role:"user",content:[{type:"input_text",text:`Reports: ${reports.length}\nNewest year: ${newestYear}\n\n${reportText}`}]}
        ],
        text:{format:{type:"json_schema",name:"exam_summary",strict:true,schema}},
        max_output_tokens:5000
      })
    });
  }catch{
    return json({error:"Die Prüfungszusammenfassung konnte die KI nicht erreichen."},502);
  }

  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    return json({error:data?.error?.message||"Die Prüfungszusammenfassung konnte nicht erstellt werden."},502);
  }

  const text=extractOutputText(data);
  let parsed;
  try{parsed=JSON.parse(text)}catch{
    return json({error:"Die KI-Zusammenfassung konnte nicht verarbeitet werden."},502);
  }

  const payload={
    schemaVersion:DATA_SCHEMA_VERSION,
    examKey,
    sourceFingerprint:fingerprint,
    reportCount:reports.length,
    years:yearsMeta(reports),
    generatedAt:new Date().toISOString(),
    summary:parsed
  };
  await summariesStore.setJSON(cacheKey,payload);
  return json({...payload,fromCache:false});
}

export const config={
  path:"/api/exam-summary",
  method:"POST",
  rateLimit:{windowLimit:20,windowSize:60,aggregateBy:["ip","domain"]}
};
