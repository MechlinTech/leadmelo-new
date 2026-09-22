'use client';
import { FormEvent, useEffect, useState } from 'react';
type Connection = {directoryId:string;clientId:string;mailboxes:string[];enabled:boolean};
export default function MicrosoftSettings() {
 const [connection,setConnection]=useState<Connection|null>(null),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function load(){const r=await fetch('/api/integrations/m365',{cache:'no-store'});if(!r.ok)throw new Error('Could not load Microsoft connection');setConnection((await r.json()).connection);}
 useEffect(()=>{load().catch(e=>setError(e.message));},[]);
 async function submit(e:FormEvent<HTMLFormElement>){
  e.preventDefault();const form=e.currentTarget;const data=new FormData(form);setBusy(true);setError('');setNotice('');
  try{
   const body={directoryId:String(data.get('directoryId')),clientId:String(data.get('clientId')),clientSecret:String(data.get('clientSecret')),mailboxes:String(data.get('mailboxes')).split(',').map(x=>x.trim().toLowerCase()).filter(Boolean),mailboxScopeConfirmed:data.get('scope')==='on'};
   const r=await fetch('/api/integrations/m365',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await r.json();if(!r.ok)throw new Error(result.error);
   form.reset();await load();setNotice('Saved securely. This does not certify live delivery. Reply sync and sender-health checks must pass before activation.');
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 async function disconnect(){setBusy(true);setError('');try{const r=await fetch('/api/integrations/m365',{method:'DELETE'});if(!r.ok)throw new Error((await r.json()).error);await load();setNotice('Microsoft sending disabled and active campaigns paused.');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <section><h2>Microsoft 365</h2><p>Admin-managed application connection. Configure scoped mailbox access in Microsoft before saving. No Microsoft sign-in or admin-consent wizard is included.</p>
 {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
 <p>{connection?connection.enabled?'Configured — live acceptance still required':'Disabled':'Not configured'}</p>
 <form className="editor" onSubmit={submit} key={connection?.clientId??'new'}>
 <div className="formGrid">
 <label>Microsoft directory ID<input className="input" name="directoryId" required defaultValue={connection?.directoryId}/></label>
 <label>Application client ID<input className="input" name="clientId" required defaultValue={connection?.clientId}/></label>
 <label>Client secret (new value or rotation)<input className="input" name="clientSecret" type="password" autoComplete="new-password" required minLength={16}/></label>
 <label>Authorized mailboxes (comma separated)<input className="input" name="mailboxes" required defaultValue={connection?.mailboxes.join(', ')}/></label>
 </div><label><input name="scope" type="checkbox" required/> An administrator has restricted this application to these mailboxes in Microsoft and approved its access.</label>
 <button disabled={busy}>Save Microsoft connection</button>
 </form>{connection?.enabled&&<button disabled={busy} onClick={()=>void disconnect()}>Disable Microsoft and pause campaigns</button>}
 </section>;
}
