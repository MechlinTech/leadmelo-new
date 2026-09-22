'use client';
import { useEffect, useState } from 'react';
type Alert={id:string;code:string;entityId:string;createdAt:string;deliveredAt:string|null;attempts:number};
export default function OperationalAlerts(){
 const [rows,setRows]=useState<Alert[]>([]),[error,setError]=useState('');
 async function load(){const r=await fetch('/api/alerts',{cache:'no-store'});if(!r.ok)throw new Error('Could not load alerts');setRows(await r.json());}
 useEffect(()=>{load().catch(e=>setError(e.message));},[]);
 async function acknowledge(id:string){try{const r=await fetch('/api/alerts',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});if(!r.ok)throw new Error((await r.json()).error);await load();}catch(e){setError((e as Error).message);}}
 return <section><h2>Operational alerts</h2><p>Acknowledging an alert does not fix or replay the underlying work.</p>{error&&<p role="alert">{error}</p>}<button onClick={()=>void load().catch(e=>setError(e.message))}>Refresh alerts</button><ul className="recordList">{rows.map(r=><li key={r.id}><strong>{r.code}</strong><p>Reference: {r.entityId}</p><p>{new Date(r.createdAt).toLocaleString()} — {r.deliveredAt?'Notification accepted by alert receiver':r.attempts>=6?'Notification retries exhausted':'Notification pending or receiver not configured'}</p><button onClick={()=>void acknowledge(r.id)}>Acknowledge</button></li>)}</ul>{!rows.length&&<p>No unacknowledged alerts in the latest 100 records.</p>}</section>;
}
