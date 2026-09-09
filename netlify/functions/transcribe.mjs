
import OpenAI from "openai";
import {json,auth} from "./_lib.mjs";

const MAX_AUDIO_BYTES=4*1024*1024;

export default async function(req){
  const a=await auth(req);
  if(!a)return json({error:"Bitte melde dich erneut an."},401);
  if(req.method!=="POST")return json({error:"Method not allowed"},405);

  // IMPORTANT:
  // This deliberately does NOT use OPENAI_API_KEY / OPENAI_BASE_URL,
  // because Netlify AI Gateway injects those variables and the Gateway
  // currently is not our reliable path for the transcription endpoint.
  const directKey=process.env.STUDYVAULT_OPENAI_API_KEY;
  if(!directKey){
    return json({
      error:"Audio-Transkription ist noch nicht aktiviert.",
      detail:"In Netlify fehlt die Environment Variable STUDYVAULT_OPENAI_API_KEY."
    },503);
  }

  let form;
  try{
    form=await req.formData();
  }catch{
    return json({error:"Die Audioaufnahme konnte nicht gelesen werden."},400);
  }

  const file=form.get("file");
  if(!(file instanceof Blob))return json({error:"Keine Audioaufnahme empfangen."},400);
  if(!file.size)return json({error:"Die Audioaufnahme ist leer."},400);
  if(file.size>MAX_AUDIO_BYTES){
    return json({error:"Die Aufnahme ist zu groß. Bitte nimm maximal etwa 3 Minuten auf."},413);
  }

  // Direct OpenAI endpoint — no Netlify AI Gateway.
  const client=new OpenAI({
    apiKey:directKey,
    baseURL:"https://api.openai.com/v1"
  });

  try{
    const result=await client.audio.transcriptions.create({
      file,
      model:process.env.STUDYVAULT_TRANSCRIBE_MODEL||"gpt-4o-mini-transcribe",
      language:"de",
      response_format:"json"
    });

    const text=String(result?.text||"").trim();
    if(text.length<10){
      return json({error:"In der Aufnahme wurde zu wenig verständliche Sprache erkannt."},422);
    }

    return json({
      text,
      model:process.env.STUDYVAULT_TRANSCRIBE_MODEL||"gpt-4o-mini-transcribe",
      route:"direct-openai"
    });
  }catch(e){
    const status=Number(e?.status)||502;
    const provider=String(e?.message||"").slice(0,500);
    console.error("StudyVault direct transcription error",{
      status,
      provider,
      type:file.type,
      size:file.size
    });

    let message="Audio konnte nicht transkribiert werden.";
    if(status===401)message="Der OpenAI API-Key für Audio ist ungültig.";
    else if(status===429)message="Das OpenAI-Limit bzw. Guthaben für Audio ist erreicht.";
    else if(status>=500)message="Der OpenAI-Transkriptionsdienst ist gerade nicht erreichbar.";

    return json({
      error:message,
      detail:provider||undefined
    },502);
  }
}

export const config={
  path:"/api/transcribe",
  method:"POST",
  rateLimit:{windowLimit:10,windowSize:60,aggregateBy:["ip","domain"]}
};
