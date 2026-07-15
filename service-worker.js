const CACHE_NAME = "nis-report-card-v6-5-8";
const STATIC_ASSETS = [
  "./","index.html","style.css","app.js","config.js","manifest.webmanifest",
  "assets/nipe-school-logo.png"
];
self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(STATIC_ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener("activate",event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});
self.addEventListener("fetch",event=>{
  const request=event.request;
  if(request.method!=="GET")return;
  const url=new URL(request.url);
  if(url.hostname.endsWith(".supabase.co")){
    event.respondWith(fetch(request).catch(()=>new Response(JSON.stringify({message:"offline"}),{status:503,headers:{"Content-Type":"application/json"}})));
    return;
  }
  if(request.mode==="navigate"){
    event.respondWith(fetch(request).then(response=>{
      const clone=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put("index.html",clone));return response;
    }).catch(()=>caches.match("index.html")));
    return;
  }
  event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{
    if(response.ok&&(url.origin===self.location.origin||url.hostname.includes("cdn"))) {
      const clone=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(request,clone));
    }
    return response;
  })));
});
self.addEventListener("sync",event=>{
  if(event.tag==="nis-outbox")event.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(clients=>clients.forEach(client=>client.postMessage({type:"FLUSH_OUTBOX"}))));
});
self.addEventListener("message",event=>{
  if(event.data?.type==="SKIP_WAITING")self.skipWaiting();
});
