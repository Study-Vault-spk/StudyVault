
import { auth } from "./_lib.mjs";

const PRIMARY_MODEL = process.env.STUDYVAULT_FLASHCARD_MODEL || process.env.STUDYVAULT_MODEL || "gpt-5.6-luna";
const FALLBACK_MODEL = "gpt-5-mini";

function json(data,status=200){
  return Response.json(data,{status,headers:{"Cache-Control":"no-store"}});
}
function extractOutputText(data){
  if(typeof data?.output_text==="string") return data.output_text;
  for(const item of data?.output||[]){
    if(item?.type!=="message") continue;
    for(const part of item.content||[]){
      if(part?.type==="output_text" && typeof part.text==="string") return part.text;
    }
  }
  return "";
}
function compactPages(pages){
  return pages.map(p=>`--- PAGE ${p.page} ---\n${String(p.text||"").trim()}`).join("\n\n");
}
function safeCount(n){
  // Keep each synchronous AI call intentionally small so it stays well inside
  // Netlify's 60 second synchronous execution limit.
  return Math.max(1,Math.min(10,Number(n)||5));
}
function makeSchema(){
  return {
    type:"object",
    additionalProperties:false,
    properties:{
      cards:{
        type:"array",
        items:{
          type:"object",
          additionalProperties:false,
          properties:{
            question:{type:"string"},
            answer:{type:"string"},
            topic:{type:"string"},
            card_type:{type:"string",enum:["definition","understanding","application","comparison","process","exam"]},
            difficulty:{type:"string",enum:["leicht","mittel","schwer"]},
            source_pages:{type:"array",items:{type:"integer"}},
            source_excerpt:{type:"string"}
          },
          required:["question","answer","topic","card_type","difficulty","source_pages","source_excerpt"]
        }
      }
    },
    required:["cards"]
  };
}

async function callOpenAI({base,key,model,developerPrompt,userText}){
  const response=await fetch(`${base}/v1/responses`,{
    method:"POST",
    headers:{
      "Authorization":`Bearer ${key}`,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      model,
      reasoning:{effort:"low"},
      input:[
        {role:"developer",content:[{type:"input_text",text:developerPrompt}]},
        {role:"user",content:[{type:"input_text",text:userText}]}
      ],
      text:{
        format:{
          type:"json_schema",
          name:"studyvault_flashcards",
          strict:true,
          schema:makeSchema()
        }
      },
      max_output_tokens:6000
    })
  });

  const data=await response.json().catch(()=>({}));
  return {response,data};
}

export default async function handler(req){
  const account=await auth(req);
  if(!account) return json({error:"Bitte melde dich erneut an.",code:"AUTH"},401);
  if(req.method!=="POST") return json({error:"Method not allowed",code:"METHOD"},405);

  const key=process.env.OPENAI_API_KEY;
  const base=(process.env.OPENAI_BASE_URL||"https://api.openai.com").replace(/\/$/,"");
  if(!key){
    return json({
      error:"Die KI-Verbindung ist auf Netlify noch nicht aktiv. Bitte AI Gateway aktivieren oder OPENAI_API_KEY hinterlegen.",
      code:"AI_NOT_CONFIGURED"
    },503);
  }

  let body;
  try{body=await req.json()}catch{
    return json({error:"Die Anfrage für die Lernkarten war ungültig.",code:"BAD_JSON"},400);
  }

  const pages=Array.isArray(body.pages)?body.pages.filter(p=>p&&String(p.text||"").trim()):[];
  if(!pages.length) return json({error:"Aus dem Dokument wurde kein Text an die KI übergeben.",code:"NO_TEXT"},400);

  const requestedCount=safeCount(body.requestedCount);
  const difficulty=["leicht","mittel","schwer"].includes(body.difficulty)?body.difficulty:"mittel";
  const focus=["gemischt","begriffe","verstaendnis","pruefung"].includes(body.focus)?body.focus:"gemischt";
  const language=body.language==="Englisch"?"English":"German";
  const documentText=compactPages(pages);

  if(documentText.length>65000){
    return json({
      error:"Dieser Dokumentabschnitt ist für eine einzelne KI-Anfrage zu groß. StudyVault teilt das Dokument normalerweise automatisch auf.",
      code:"CHUNK_TOO_LARGE"
    },413);
  }

  const difficultyGuide={
    leicht:"Direkte, klare Fragen zu Grundbegriffen, Definitionen und zentralen Fakten.",
    mittel:"Mische Grundlagen, Verständnis und einfache Anwendung. Antworten sollen kurz erklären.",
    schwer:"Nutze anspruchsvollere Verständnis-, Transfer- und Anwendungsfragen, aber keine künstlichen Fangfragen."
  }[difficulty];

  const focusGuide={
    gemischt:"Ausgewogene Mischung aus Definitionen, Verständnis, Zusammenhängen und Anwendung.",
    begriffe:"Priorisiere Begriffe, Definitionen, Abgrenzungen und zentrale Fakten.",
    verstaendnis:"Priorisiere Warum-, Wie- und Zusammenhangsfragen.",
    pruefung:"Priorisiere realistische Klausur- und mündliche Prüfungsfragen."
  }[focus];

  const developerPrompt=`Create high-quality flashcards using ONLY the supplied study-document pages.

Grounding rules:
- Never use outside knowledge.
- Every answer must be directly supported by the supplied pages.
- Every card needs one or more valid source_pages.
- source_excerpt must be a short verbatim excerpt from a cited page.
- Avoid duplicate or near-duplicate questions.
- One main idea per card.
- Ignore page numbers, headers, footers, bibliographies and legal notices unless academically relevant.
- Prefer central, examinable and explanatory material.
- If there is not enough reliable material, return fewer cards rather than inventing content.

Difficulty:
${difficultyGuide}

Focus:
${focusGuide}

Output language:
${language}

Aim for ${requestedCount} useful flashcards.`;

  const userText=`File: ${body.fileName||"study-document"}
Part ${Number(body.chunkIndex||0)+1} of ${Number(body.totalChunks||1)}

${documentText}`;

  let result;
  try{
    result=await callOpenAI({
      base,key,model:PRIMARY_MODEL,developerPrompt,userText
    });
  }catch(e){
    console.error("StudyVault flashcards network error",e);
    return json({
      error:"Die KI konnte nicht erreicht werden. Bitte versuche es erneut.",
      code:"AI_NETWORK"
    },502);
  }

  // If a model-specific/gateway error happens, retry once with a very broadly
  // supported structured-output model.
  if(!result.response.ok && [400,404,422].includes(result.response.status) && PRIMARY_MODEL!==FALLBACK_MODEL){
    console.warn("StudyVault primary model failed, retrying fallback",result.data?.error);
    try{
      result=await callOpenAI({
        base,key,model:FALLBACK_MODEL,developerPrompt,userText
      });
    }catch(e){
      console.error("StudyVault fallback network error",e);
    }
  }

  if(!result?.response?.ok){
    const status=result?.response?.status||502;
    const providerMessage=String(result?.data?.error?.message||"").slice(0,500);
    console.error("StudyVault AI provider error",{
      status,
      model:PRIMARY_MODEL,
      providerMessage
    });

    let friendly="Die KI konnte die Lernkarten gerade nicht erstellen.";
    if(status===401||status===403) friendly="Die KI-Verbindung von Netlify ist nicht korrekt autorisiert.";
    else if(status===429) friendly="Die KI ist gerade ausgelastet oder das Nutzungslimit wurde erreicht. Bitte kurz warten.";
    else if(status>=500) friendly="Der KI-Dienst ist gerade nicht erreichbar. Bitte versuche es gleich erneut.";

    return json({
      error:friendly,
      code:"AI_PROVIDER",
      detail:providerMessage||undefined
    },502);
  }

  const text=extractOutputText(result.data);
  if(!text){
    console.error("StudyVault AI returned no output_text",result.data);
    return json({
      error:"Die KI hat keine verwertbaren Lernkarten zurückgegeben. Bitte versuche es erneut.",
      code:"AI_EMPTY"
    },502);
  }

  let parsed;
  try{
    parsed=JSON.parse(text);
  }catch(e){
    console.error("StudyVault structured output parse error",text.slice(0,800));
    return json({
      error:"Die KI-Antwort konnte nicht verarbeitet werden. Bitte versuche es erneut.",
      code:"AI_PARSE"
    },502);
  }

  const validPages=new Set(pages.map(p=>Number(p.page)));
  const seen=new Set();
  const cards=[];

  for(const [i,c] of (parsed.cards||[]).entries()){
    const question=String(c.question||"").trim();
    const answer=String(c.answer||"").trim();
    const norm=question.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,"").replace(/\s+/g," ").trim();
    if(!question||!answer||!norm||seen.has(norm))continue;

    const sourcePages=[...new Set((c.source_pages||[]).map(Number).filter(p=>validPages.has(p)))].slice(0,3);
    if(!sourcePages.length)continue;

    seen.add(norm);
    cards.push({
      id:`${Date.now()}-${i}`,
      question,
      answer,
      topic:String(c.topic||"Dokument").trim().slice(0,100),
      card_type:c.card_type||"understanding",
      difficulty:c.difficulty||difficulty,
      source_pages:sourcePages,
      source_excerpt:String(c.source_excerpt||"").trim().slice(0,350)
    });
  }

  if(!cards.length){
    return json({
      error:"Aus diesem Abschnitt konnten keine eindeutig belegten Lernkarten erstellt werden. Bitte versuche einen anderen Umfang oder ein anderes Dokument.",
      code:"NO_GROUNDED_CARDS"
    },422);
  }

  return json({
    cards:cards.slice(0,requestedCount),
    model:result.data.model||PRIMARY_MODEL,
    usage:result.data.usage||null
  });
}

export const config={
  path:"/api/generate-cards",
  method:"POST",
  rateLimit:{
    windowLimit:30,
    windowSize:60,
    aggregateBy:["ip","domain"]
  }
};
