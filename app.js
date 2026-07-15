(() => {
  "use strict";

  const CONFIG = Object.freeze({
    supabaseUrl: window.NIS_CONFIG?.supabaseUrl || "YOUR_SUPABASE_URL",
    supabaseAnonKey: window.NIS_CONFIG?.supabaseAnonKey || "YOUR_SUPABASE_ANON_KEY",
    appName: window.NIS_CONFIG?.appName || "Nipe International School Report Card System",
    logoPath: window.NIS_CONFIG?.logoPath || "assets/nipe-school-logo.png",
    photoBucket: "student-photos",
    pdfBucket: "report-pdfs",
    backupBucket: "system-backups",
    signatureBucket: "headteacher-signatures",
    pageSize: 20
  });

  const ROLE_LABELS = {
    system_admin: "System Administrator",
    principal: "Principal (Headmaster/Headmistress)",
    class_teacher: "Class Teacher",
    subject_teacher: "Subject Teacher",
    parent_guardian: "Parent or Guardian"
  };

  const NAV = [
    {id:"dashboard",label:"Dashboard",icon:"▦",subtitle:"Academic performance overview"},
    {id:"my_class",label:"My Class",icon:"▣",subtitle:"Assigned class, learners, and report progress",roles:["class_teacher"]},
    {id:"my_subjects",label:"My Subjects",icon:"⌘",subtitle:"Assigned subjects, classes, and assessment progress",roles:["subject_teacher"]},
    {id:"students",label:"Students",icon:"◉",subtitle:"Student records and enrolment",roles:["system_admin","class_teacher","subject_teacher"]},
    {id:"teachers",label:"Teachers",icon:"♜",subtitle:"Teacher records and assignments",permission:"manage_teachers"},
    {id:"headteachers",label:"Principals",icon:"★",subtitle:"Principal records and appointments",permission:"manage_headteachers"},
    {id:"academics",label:"Academics",icon:"⌘",subtitle:"Academic structure and assessment",permission:"manage_academics"},
    {id:"reports",label:"Report Cards",icon:"▤",subtitle:"Assessment, approval, and publication",hideFor:["parent_guardian"]},
    {id:"children",label:"My Children",icon:"♥",subtitle:"Published academic records",roles:["parent_guardian"]},
    {id:"users",label:"Users and Access",icon:"♟",subtitle:"Roles, classes, and security",permission:"manage_users"},
    {id:"notifications",label:"Notifications",icon:"◆",subtitle:"School and workflow alerts"},
    {id:"audit",label:"Audit Trail",icon:"◎",subtitle:"Record changes and accountability",permission:"view_audit"},
    {id:"settings",label:"Settings",icon:"⚙",subtitle:"School identity, security, and resilience",roles:["system_admin"]}
  ];

  const ROLE_NAV_IDS = Object.freeze({
    system_admin:["dashboard","students","teachers","headteachers","academics","reports","users","notifications","audit","settings"],
    principal:["dashboard","reports","notifications"],
    class_teacher:["dashboard","my_class","students","reports","notifications"],
    subject_teacher:["dashboard","my_subjects","students","reports","notifications"],
    parent_guardian:["dashboard","children","notifications"]
  });

  const state = {
    client:null, session:null, boot:null, view:"dashboard", viewToken:0,
    channels:[], photoUrls:new Map(), pdfUrls:new Map(), signatureUrls:new Map(), online:navigator.onLine,
    studentPage:1, teacherPage:1, headteacherPage:1, reportPage:1, currentStudent:null, reportEditor:null,
    academicTab:"periods", notifications:[], mfaFactorId:null, mfaEnrollment:null,
    teacherAdmin:null, headteacherAdmin:null, userAdmin:null, userAccessRows:[], guardianAccounts:[], autoComments:null,
    workspace:null, studentClassFilter:"", reportClassFilter:"",
    initialized:false, realtimeConnected:0, lastSync:null, pending:0, conflicts:0
  };

  const $ = (selector, root=document) => root.querySelector(selector);
  const $$ = (selector, root=document) => [...root.querySelectorAll(selector)];
  const byId = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  })[ch]);
  const attr = esc;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const uuid = () => crypto.randomUUID();
  const isoDate = value => value ? new Date(value).toLocaleDateString("en-GH",{year:"numeric",month:"short",day:"numeric"}) : "—";
  const isoDateTime = value => value ? new Date(value).toLocaleString("en-GH",{year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}) : "—";
  const number = (value,digits=0) => Number(value || 0).toLocaleString("en-GH",{minimumFractionDigits:digits,maximumFractionDigits:digits});
  const fullName = row => [row?.first_name,row?.middle_name,row?.last_name].filter(Boolean).join(" ");
  const activeYear = () => state.boot?.academic_years?.find(x=>x.is_active) || null;
  const activeTerm = () => state.boot?.terms?.find(x=>x.is_active) || null;
  const role = () => state.boot?.profile?.role || "";
  const can = key => Boolean(state.boot?.permissions?.[key]);
  const isConfigured = () => /^https:\/\/.+\.supabase\.co$/i.test(CONFIG.supabaseUrl) && !CONFIG.supabaseAnonKey.startsWith("YOUR_");

  function toast(title, message="", type="success", timeout=4200) {
    const node=document.createElement("div");
    node.className=`toast ${type}`;
    node.innerHTML=`<div><strong>${esc(title)}</strong>${message?`<span>${esc(message)}</span>`:""}</div>`;
    byId("toastStack").append(node);
    setTimeout(()=>node.remove(),timeout);
  }

  function setLoading(show) { byId("loader").classList.toggle("hidden",!show); }
  function setAuthMessage(message="") { byId("authMessage").textContent=message; }
  function setMfaMessage(message="") { byId("mfaMessage").textContent=message; }
  function setSync(mode,label) {
    const pill=byId("syncIndicator");
    pill.className=`sync-pill ${mode}`;
    if(mode==="online") state.lastSync=new Date();
    const stamp=state.lastSync?.toLocaleTimeString("en-GH",{hour:"2-digit",minute:"2-digit"})||"";
    const display=mode==="online"&&stamp?`${label} • ${stamp}`:label;
    byId("syncLabel").textContent=display;
    pill.title=mode==="online"&&state.lastSync?`Last synchronised ${state.lastSync.toLocaleString("en-GH")}`:label;
  }
  function showOnly(id) {
    ["verifyView","authView","mfaView","appShell"].forEach(name=>byId(name).classList.toggle("hidden",name!==id));
  }
  function statusBadge(status) {
    const value=String(status||"draft");
    return `<span class="status ${attr(value)}">${esc(value.replaceAll("_"," "))}</span>`;
  }
  function optionList(rows,valueKey,labelKey,selected="",blank="Select") {
    return `<option value="">${esc(blank)}</option>`+rows.map(row=>
      `<option value="${attr(row[valueKey])}" ${String(row[valueKey])===String(selected)?"selected":""}>${esc(row[labelKey])}</option>`
    ).join("");
  }
  function modal(title,subtitle,body,footer="",size="") {
    const dialog=byId("modal"),bodyHost=byId("modalBody"),footerHost=byId("modalFooter");
    dialog.className=`modal ${size}`.trim();
    byId("modalTitle").textContent=title;
    byId("modalSubtitle").textContent=subtitle||"";
    bodyHost.innerHTML=body;
    footerHost.innerHTML=footer;
    if(/<form\b/i.test(body)&&!bodyHost.querySelector("form")){
      const error=new Error("The record form could not be created.");
      toast("Form unavailable","Reload the application and try again.","error",6500);
      throw error;
    }
    if(!dialog.open) dialog.showModal();
    return dialog;
  }
  function closeModal(){
    const dialog=byId("modal");
    if(dialog.open) dialog.close();
    byId("modalBody").replaceChildren();
    byId("modalFooter").replaceChildren();
  }
  function confirmAction(title,message,confirmLabel="Continue",danger=false) {
    return new Promise(resolve=>{
      modal(title,"",`<p>${esc(message)}</p>`,
        `<button class="button ghost" type="button" id="confirmCancel">Cancel</button>
         <button class="button ${danger?"danger":"primary"}" type="button" id="confirmOk">${esc(confirmLabel)}</button>`,"small");
      byId("confirmCancel").onclick=()=>{closeModal();resolve(false)};
      byId("confirmOk").onclick=()=>{closeModal();resolve(true)};
    });
  }

  async function rpc(name,args={}) {
    const {data,error}=await state.client.rpc(name,args);
    if(error) throw error;
    state.lastSync=new Date();
    return data;
  }
  async function query(builder) {
    const {data,error}=await builder;
    if(error) throw error;
    state.lastSync=new Date();
    return data;
  }
  async function reportClientError(error,context={}) {
    console.error(error);
    if(!state.client || !state.session) return;
    try {
      await state.client.rpc("log_client_error",{
        message_text:error?.message||String(error),stack_text:error?.stack||"",
        context_data:context,user_agent_text:navigator.userAgent
      });
    } catch (_) {}
  }
  function friendlyError(error) {
    const msg=error?.message||String(error||"Operation failed");
    if(msg.includes("40001")||msg.includes("changed by another user")) return "Another user changed this record. The latest version has been loaded.";
    if(msg.includes("42501")||msg.toLowerCase().includes("access denied")) return "You do not have permission to complete this operation.";
    if(msg.toLowerCase().includes("failed to fetch")||msg.toLowerCase().includes("network")) return "The server could not be reached.";
    return msg;
  }
  async function run(action,{success="",context={}}={}) {
    try {
      const result=await action();
      if(success) toast(success);
      return result;
    } catch(error) {
      await reportClientError(error,context);
      toast("Operation unsuccessful",friendlyError(error),"error",6500);
      throw error;
    }
  }

  function openLocalDb() {
    return new Promise((resolve,reject)=>{
      const request=indexedDB.open("nis-report-card",2);
      request.onupgradeneeded=()=>{
        const db=request.result;
        if(!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox",{keyPath:"id"});
        if(!db.objectStoreNames.contains("drafts")) db.createObjectStore("drafts",{keyPath:"key"});
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
  }
  async function idbTransaction(store,mode,operation) {
    const db=await openLocalDb();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(store,mode), os=tx.objectStore(store);
      let request;
      try { request=operation(os); } catch(error){ reject(error);return; }
      tx.oncomplete=()=>resolve(request?.result);
      tx.onerror=()=>reject(tx.error);
    });
  }
  const outboxAll=()=>idbTransaction("outbox","readonly",os=>os.getAll());
  const outboxPut=item=>idbTransaction("outbox","readwrite",os=>os.put(item));
  const outboxDelete=id=>idbTransaction("outbox","readwrite",os=>os.delete(id));
  const draftPut=item=>idbTransaction("drafts","readwrite",os=>os.put(item));
  const draftGet=key=>idbTransaction("drafts","readonly",os=>os.get(key));
  const draftDelete=key=>idbTransaction("drafts","readwrite",os=>os.delete(key));

  async function refreshPendingCount() {
    const items=await outboxAll().catch(()=>[]);
    state.pending=items.filter(x=>x.status!=="conflict").length;
    state.conflicts=items.filter(x=>x.status==="conflict").length;
    const bar=byId("offlineBar");
    byId("outboxCount").textContent=[state.pending?`${state.pending} pending`:"",state.conflicts?`${state.conflicts} conflict${state.conflicts===1?"":"s"}`:""].filter(Boolean).join(" • ")||"0 pending";
    bar.classList.toggle("conflict",state.conflicts>0);
    bar.classList.toggle("hidden",state.online && state.pending===0 && state.conflicts===0);
    if(!state.online) setSync("offline","Offline");
    else if(state.conflicts) setSync("error",`${state.conflicts} conflict${state.conflicts===1?"":"s"}`);
    else if(state.pending) setSync("pending",`${state.pending} pending`);
  }
  async function queueReportSave(payload,expectedVersion) {
    const item={id:uuid(),type:"save_report",payload,expectedVersion,createdAt:new Date().toISOString(),status:"pending"};
    await outboxPut(item);
    await refreshPendingCount();
    toast("Saved offline","The report will synchronise automatically.","warning");
    return state.reportEditor;
  }
  async function flushOutbox() {
    if(!state.online||!state.session) return;
    const items=(await outboxAll().catch(()=>[])).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
    for(const item of items) {
      if(item.status==="conflict") continue;
      try {
        if(item.type==="save_report") await rpc("save_report_card",{payload:item.payload,expected_version:item.expectedVersion});
        await outboxDelete(item.id);
      } catch(error) {
        if(error?.code==="40001"||String(error?.message).includes("changed by another user")) {
          item.status="conflict"; item.error=error.message; await outboxPut(item);
          toast("Synchronisation conflict","A queued report needs review.","error",7000);
        } else break;
      }
    }
    await refreshPendingCount();
    if(state.online && state.pending===0) setSync("online","Synced");
  }

  async function openSyncQueue() {
    const items=(await outboxAll().catch(()=>[])).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    modal("Synchronisation Queue",`${items.length} record${items.length===1?"":"s"}`,items.length?`
      <div class="stack-list">${items.map(item=>`<article class="list-card">
        <div><strong>${item.status==="conflict"?"Conflict":"Pending report"}</strong><small>${isoDateTime(item.createdAt)}</small>${item.error?`<span class="form-message">${esc(item.error)}</span>`:""}</div>
        <div class="button-row">
          ${item.status==="conflict"?`<button class="button primary small" type="button" data-sync-retry="${attr(item.id)}">Retry</button><button class="button outline small" type="button" data-sync-server="${attr(item.id)}">Use server record</button>`:""}
          <button class="button ghost small" type="button" data-sync-remove="${attr(item.id)}">Remove</button>
        </div>
      </article>`).join("")}</div>`:`<div class="empty"><strong>Queue clear</strong></div>`,
      `<button class="button ghost" id="syncQueueClose" type="button">Close</button>`,"wide");
    byId("syncQueueClose").onclick=closeModal;
    $$('[data-sync-remove]').forEach(button=>button.onclick=async()=>{await outboxDelete(button.dataset.syncRemove);await refreshPendingCount();openSyncQueue()});
    $$('[data-sync-server]').forEach(button=>button.onclick=async()=>{
      const item=items.find(x=>x.id===button.dataset.syncServer);await outboxDelete(item.id);await refreshPendingCount();
      if(item?.payload?.report_id){state.reportEditor=await rpc("get_report_editor",{target_report_id:item.payload.report_id,target_enrollment_id:null,target_term_id:null});}
      closeModal();if(state.view==="reports"&&state.reportEditor)renderReportEditor();
    });
    $$('[data-sync-retry]').forEach(button=>button.onclick=async()=>{
      const item=items.find(x=>x.id===button.dataset.syncRetry);if(!item)return;
      if(item.payload?.report_id){const current=await rpc("get_report_editor",{target_report_id:item.payload.report_id,target_enrollment_id:null,target_term_id:null});item.expectedVersion=Number(current.report.version);}
      item.status="pending";item.error="";await outboxPut(item);closeModal();await refreshPendingCount();await flushOutbox();
    });
  }

  async function signedUrl(bucket,path,seconds=900) {
    if(!path) return "";
    if(/^https?:\/\//i.test(path)||path.startsWith("data:")||path.startsWith("assets/")) return path;
    const cache=bucket===CONFIG.photoBucket?state.photoUrls:bucket===CONFIG.signatureBucket?state.signatureUrls:state.pdfUrls;
    const cached=cache.get(path);
    if(cached&&cached.expires>Date.now()) return cached.url;
    const {data,error}=await state.client.storage.from(bucket).createSignedUrl(path,seconds);
    if(error) throw error;
    cache.set(path,{url:data.signedUrl,expires:Date.now()+(seconds-30)*1000});
    return data.signedUrl;
  }

  async function init() {
    byId("togglePassword").onclick=()=>{
      const input=byId("loginPassword");
      input.type=input.type==="password"?"text":"password";
    };
    byId("modalClose").onclick=()=>closeModal();
    byId("modal").addEventListener("cancel",event=>{event.preventDefault();closeModal()});
    byId("loginForm").addEventListener("submit",login);
    byId("mfaForm").addEventListener("submit",verifyMfa);
    byId("mfaSignOut").onclick=logout;
    byId("logoutButton").onclick=logout;
    byId("menuButton").onclick=()=>byId("sidebar").classList.toggle("open");
    byId("refreshButton").onclick=()=>navigate(state.view,true);
    byId("notificationButton").onclick=()=>navigate("notifications");
    byId("offlineBar").onclick=openSyncQueue;
    byId("offlineBar").onkeydown=event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();openSyncQueue()}};
    window.addEventListener("online",async()=>{state.online=true;await refreshPendingCount();await flushOutbox();await reconnectRealtime()});
    window.addEventListener("offline",async()=>{state.online=false;await refreshPendingCount()});
    window.addEventListener("beforeunload",event=>{if(state.pending||state.conflicts){event.preventDefault();event.returnValue=""}});
    window.addEventListener("error",event=>reportClientError(event.error||new Error(event.message),{source:"window"}));
    window.addEventListener("unhandledrejection",event=>reportClientError(event.reason,{source:"promise"}));
    if("serviceWorker" in navigator) {
      navigator.serviceWorker.register("service-worker.js").catch(()=>{});
      navigator.serviceWorker.addEventListener("message",event=>{if(event.data?.type==="FLUSH_OUTBOX")flushOutbox()});
    }
    await refreshPendingCount();

    const verifyToken=new URLSearchParams(location.search).get("verify");
    if(verifyToken) {
      await showVerification(verifyToken);
      setLoading(false);
      return;
    }
    if(!isConfigured()||!window.supabase?.createClient) {
      showOnly("authView");
      setAuthMessage("Service unavailable.");
      setLoading(false);
      return;
    }
    state.client=window.supabase.createClient(CONFIG.supabaseUrl,CONFIG.supabaseAnonKey,{
      auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true},
      realtime:{params:{eventsPerSecond:20}}
    });
    const {data:{session}}=await state.client.auth.getSession();
    state.session=session;
    state.client.auth.onAuthStateChange(async(event,newSession)=>{
      state.session=newSession;
      if(event==="SIGNED_OUT"){state.initialized=false;disconnectRealtime();showOnly("authView");}
      if(event==="TOKEN_REFRESHED"&&newSession) await state.client.realtime.setAuth(newSession.access_token).catch(()=>{});
    });
    if(session) await startAuthenticated();
    else {showOnly("authView");setLoading(false);}
  }

  async function login(event) {
    event.preventDefault(); setAuthMessage("");
    const email=byId("loginEmail").value.trim(),password=byId("loginPassword").value;
    const button=$("#loginForm button[type=submit]");button.disabled=true;
    try {
      const {data,error}=await state.client.auth.signInWithPassword({email,password});
      if(error) throw error;
      state.session=data.session;
      await startAuthenticated();
    } catch(error){setAuthMessage(friendlyError(error));}
    finally{button.disabled=false;}
  }
  async function logout() {
    disconnectRealtime();
    await state.client?.auth.signOut();
    state.boot=null;state.session=null;state.initialized=false;
    showOnly("authView");setLoading(false);
  }

  async function startAuthenticated() {
    setLoading(true);
    try {
      await rpc("ensure_current_user_profile");
      state.boot=await rpc("get_bootstrap_data");
      if(!state.boot?.profile?.active) throw new Error("Account inactive");
      const verified=await ensureMfa();
      if(!verified){setLoading(false);return;}
      await initializeApp();
    } catch(error) {
      await reportClientError(error,{source:"bootstrap"});
      await state.client.auth.signOut().catch(()=>{});
      showOnly("authView");setAuthMessage(friendlyError(error));setLoading(false);
    }
  }
  async function ensureMfa() {
    if(!state.boot.profile.mfa_required) return true;
    const {data:aal,error}=await state.client.auth.mfa.getAuthenticatorAssuranceLevel();
    if(error) throw error;
    if(aal.currentLevel==="aal2") return true;
    const {data:factors,error:factorError}=await state.client.auth.mfa.listFactors();
    if(factorError) throw factorError;
    const verified=(factors.totp||[]).find(f=>f.status==="verified");
    if(verified) {
      state.mfaFactorId=verified.id;state.mfaEnrollment=null;
      byId("mfaQr").classList.add("hidden");showOnly("mfaView");byId("mfaCode").focus();return false;
    }
    const {data:enrollment,error:enrollError}=await state.client.auth.mfa.enroll({
      factorType:"totp",friendlyName:"Nipe International School"
    });
    if(enrollError) throw enrollError;
    state.mfaFactorId=enrollment.id;state.mfaEnrollment=enrollment;
    const qr=byId("mfaQr");qr.innerHTML=`<img src="${attr(enrollment.totp.qr_code)}" alt="Authentication QR code">`;qr.classList.remove("hidden");
    showOnly("mfaView");byId("mfaCode").focus();return false;
  }
  async function verifyMfa(event) {
    event.preventDefault();setMfaMessage("");
    const code=byId("mfaCode").value.trim();
    const button=$("#mfaForm button[type=submit]");button.disabled=true;
    try {
      const {error}=await state.client.auth.mfa.challengeAndVerify({factorId:state.mfaFactorId,code});
      if(error) throw error;
      byId("mfaCode").value="";state.mfaEnrollment=null;
      state.boot=await rpc("get_bootstrap_data");
      await initializeApp();
    } catch(error){setMfaMessage(friendlyError(error));}
    finally{button.disabled=false;}
  }

  async function initializeApp() {
    state.initialized=true;
    renderBrand();renderNav();showOnly("appShell");
    await state.client.realtime.setAuth(state.session.access_token).catch(()=>{});
    await connectRealtime();
    await loadNotificationCount();
    await flushOutbox();
    await navigate("dashboard",true);
    setLoading(false);
  }
  function renderBrand() {
    const school=state.boot.school||{};
    byId("brandLogo").src=school.logo_url||CONFIG.logoPath;
    byId("brandName").textContent=school.school_name||"Nipe International School";
    byId("userName").textContent=state.boot.profile.full_name||state.session.user.email;
    byId("userRole").textContent=ROLE_LABELS[role()]||role();
    byId("userAvatar").textContent=(state.boot.profile.full_name||"N").trim().charAt(0).toUpperCase();
    document.documentElement.style.setProperty("--navy",school.primary_colour||"#082d70");
    document.documentElement.style.setProperty("--gold",school.accent_colour||"#f0b51d");
  }
  function availableNavItems() {
    const ordered=ROLE_NAV_IDS[role()]||["dashboard"];
    return ordered.map(id=>NAV.find(item=>item.id===id)).filter(item=>{
      if(!item)return false;
      if(item.permission&&!can(item.permission))return false;
      if(item.roles&&!item.roles.includes(role()))return false;
      if(item.hideFor?.includes(role()))return false;
      return true;
    });
  }
  function renderNav() {
    byId("mainNav").innerHTML=availableNavItems().map(item=>`<button class="nav-item ${item.id===state.view?"active":""}" data-view="${item.id}">
      <span class="nav-icon">${item.icon}</span><span>${esc(item.label)}</span></button>`).join("");
    $$(".nav-item",byId("mainNav")).forEach(button=>button.onclick=()=>navigate(button.dataset.view));
  }
  async function navigate(view,force=false) {
    const allowed=availableNavItems();
    let item=allowed.find(x=>x.id===view);
    if(!item){item=allowed.find(x=>x.id==="dashboard")||allowed[0];if(!item)return;view=item.id;}
    state.view=view;state.viewToken++;
    renderNav();byId("pageTitle").textContent=item.label;byId("pageSubtitle").textContent=item.subtitle;
    byId("sidebar").classList.remove("open");byId("content").innerHTML=`<div class="panel pad"><div class="skeleton"></div></div>`;
    const token=state.viewToken;
    try {
      const renderer={
        dashboard:renderDashboard,my_class:renderMyClass,my_subjects:renderMySubjects,students:renderStudents,teachers:renderTeachers,headteachers:renderPrincipals,academics:renderAcademics,reports:renderReports,
        children:renderChildren,users:renderUsers,notifications:renderNotifications,audit:renderAudit,settings:renderSettings
      }[view];
      await renderer?.(token,force);
      if(token===state.viewToken) {setSync(state.online?"online":"offline",state.online?"Synced":"Offline");byId("content").focus();}
    } catch(error) {
      if(token!==state.viewToken)return;
      await reportClientError(error,{view});
      byId("content").innerHTML=`<div class="panel pad empty"><strong>Unable to load</strong><span>${esc(friendlyError(error))}</span></div>`;
      setSync(state.online?"pending":"offline",state.online?"Retry required":"Offline");
    }
  }

  async function disconnectRealtime() {
    for(const channel of state.channels) await state.client?.removeChannel(channel).catch(()=>{});
    state.channels=[];state.realtimeConnected=0;
  }
  async function reconnectRealtime(){if(state.session){await disconnectRealtime();await connectRealtime()}}
  async function connectRealtime() {
    await disconnectRealtime();
    const topics=state.boot?.topics||[];
    if(!topics.length){setSync("online","Connected");return;}
    setSync("pending","Connecting");
    for(const topic of topics.slice(0,120)) {
      const channel=state.client.channel(topic,{config:{private:true,broadcast:{self:false},presence:{key:state.session.user.id}}});
      ["INSERT","UPDATE","DELETE"].forEach(event=>channel.on("broadcast",{event},payload=>handleRealtime(topic,payload)));
      channel.on("presence",{event:"sync"},()=>{});
      channel.subscribe(async status=>{
        if(status==="SUBSCRIBED"){
          state.realtimeConnected++;
          await channel.track({user_id:state.session.user.id,at:new Date().toISOString(),view:state.view}).catch(()=>{});
          if(state.realtimeConnected===state.channels.length)setSync("online","Live");
        } else if(["CHANNEL_ERROR","TIMED_OUT","CLOSED"].includes(status)) setSync("pending","Reconnecting");
      });
      state.channels.push(channel);
    }
  }
  function handleRealtime(topic,payload) {
    state.lastSync=new Date();setSync("online","Live");
    const table=payload?.payload?.table||payload?.table||"";
    if(["profiles","user_class_access","teachers","headteachers","classes","subjects","class_subjects","students","enrollments","student_reports","subject_results"].includes(table))state.workspace=null;
    if(topic.startsWith("user:")||table==="notifications") loadNotificationCount();
    clearTimeout(handleRealtime.timer);
    handleRealtime.timer=setTimeout(()=>{
      if(state.view==="dashboard") renderDashboard(state.viewToken,true);
      else if(state.view==="students"&&(table==="students"||table==="enrollments"||topic.startsWith("student:"))) renderStudents(state.viewToken,true);
      else if(state.view==="teachers"&&(table==="teachers"||table==="profiles"||table==="classes"||table==="class_subjects"||topic==="school:global")) renderTeachers(state.viewToken,true);
      else if(state.view==="headteachers"&&(table==="headteachers"||table==="profiles"||topic==="school:global")) renderPrincipals(state.viewToken,true);
      else if(state.view==="users"&&(table==="profiles"||table==="user_class_access"||table==="teachers"||table==="headteachers"||topic==="school:global")) renderUsers(state.viewToken,true);
      else if(state.view==="reports"||state.view==="children") {
        if(state.reportEditor&&topic===`report:${state.reportEditor.report?.id}`) refreshOpenReport();
        else navigate(state.view,true);
      } else if(state.view==="academics"&&topic==="school:global") renderAcademics(state.viewToken,true);
      else if(state.view==="my_class") renderMyClass(state.viewToken,true);
      else if(state.view==="my_subjects") renderMySubjects(state.viewToken,true);
      else if(state.view==="notifications") renderNotifications(state.viewToken,true);
    },220);
  }

  async function loadNotificationCount() {
    if(!state.session)return;
    try {
      const data=await rpc("list_notifications",{page_number:1,page_size:5});
      state.notifications=data.rows||[];
      const badge=byId("notificationBadge"),count=Number(data.unread||0);
      badge.textContent=count>99?"99+":String(count);badge.classList.toggle("hidden",count===0);
    } catch(_){}
  }

  init().catch(error=>{console.error(error);showOnly("authView");setAuthMessage("Service unavailable.");setLoading(false)});


  async function renderDashboard(token) {
    const term=activeTerm();
    const metrics=await rpc("get_role_dashboard",{target_term_id:term?.id||null});
    if(token!==state.viewToken)return;
    const currentRole=role(),statuses=metrics.by_status||{},reports=Number(metrics.reports||0),published=Number(metrics.published||0);
    const signatureRecord=currentRole==="principal"?await rpc("get_my_headteacher_signature").catch(error=>({linked:false,error:friendlyError(error)})):null;
    if(token!==state.viewToken)return;
    const completion=reports?Math.round(published/reports*100):0;
    const configs={
      system_admin:{title:"System Administration Dashboard",subtitle:"Users, records, security, and report operations",cards:[["blue","♟","Active Users",metrics.active_users],["gold","♜","Active Teachers",metrics.active_teachers],["green","◉","Active Students",metrics.active_students],["purple","▤","Report Cards",reports]]},
      principal:{title:"Principal Dashboard",subtitle:"School performance, approvals, and publication",cards:[["blue","◉","Active Students",metrics.active_students],["gold","⌛","Awaiting Action",metrics.pending_review],["green","✓","Published Reports",published],["purple","%","Published Average",number(metrics.average,1)+"%"]]},
      class_teacher:{title:"Class Teacher Dashboard",subtitle:"Assigned learners, reports, and class progress",cards:[["blue","▣","Assigned Classes",metrics.assigned_classes],["gold","◉","Visible Students",metrics.active_students],["green","✎","Draft or Returned",metrics.draft_returned],["purple","⌛","In Review",metrics.pending_review]]},
      subject_teacher:{title:"Subject Teacher Dashboard",subtitle:"Assigned subjects and assessment workload",cards:[["blue","⌘","Assigned Subjects",metrics.assigned_subjects],["gold","▣","Assigned Classes",metrics.assigned_classes],["green","✎","Open Reports",metrics.draft_returned],["purple","%","Published Average",number(metrics.average,1)+"%"]]},
      parent_guardian:{title:"Parent and Guardian Dashboard",subtitle:"Linked children and published academic records",cards:[["blue","♥","My Children",metrics.children],["gold","✓","Published Reports",published],["green","◆","Unread Notifications",metrics.unread_notifications],["purple","%","Average",number(metrics.average,1)+"%"]]}
    };
    const cfg=configs[currentRole]||configs.parent_guardian;
    byId("content").innerHTML=`
      <div class="page-head"><div><h3>${esc(cfg.title)}</h3><p>${esc(cfg.subtitle)}</p></div><div class="page-actions">${dashboardQuickActions(currentRole)}</div></div>
      <div class="stat-grid">${cfg.cards.map(card=>statCard(...card)).join("")}</div>
      ${currentRole==="principal"?headteacherSignaturePanel(signatureRecord):""}
      <div class="grid two">
        <section class="panel"><div class="panel-header"><div><h3>Current Academic Period</h3><p>${esc(activeYear()?.name||"No active academic year")} • ${esc(term?.name||"No active term")}</p></div></div>
          <div class="panel-body"><div class="metric-row"><div class="metric"><span>Draft</span><strong>${number(statuses.draft)}</strong></div><div class="metric"><span>Submitted</span><strong>${number(statuses.submitted)}</strong></div><div class="metric"><span>Approved</span><strong>${number(statuses.approved)}</strong></div><div class="metric"><span>Completion</span><strong>${completion}%</strong></div></div><div class="progress"><span style="width:${completion}%"></span></div></div>
        </section>
        <section class="panel"><div class="panel-header"><div><h3>Class Performance</h3><p>Published report averages</p></div></div><div class="panel-body"><div class="bar-list">
          ${(metrics.class_performance||[]).length?(metrics.class_performance||[]).map(row=>`<div class="bar-item"><label>${esc(row.class_name)}</label><div class="bar-track"><span style="width:${Math.min(100,Number(row.average||0))}%"></span></div><b>${number(row.average,1)}</b></div>`).join(""):`<div class="empty"><strong>No published results</strong></div>`}
        </div></div></section>
      </div>
      <section class="panel" style="margin-top:18px"><div class="panel-header"><div><h3>Recent Report Cards</h3><p>Latest authorised activity</p></div>${currentRole!=="parent_guardian"?`<button class="button secondary small" data-open-reports>View reports</button>`:`<button class="button secondary small" data-open-children>View children</button>`}</div>${reportTable(metrics.recent||[],true)}</section>`;
    $(`[data-open-reports]`)?.addEventListener("click",()=>navigate("reports"));
    $(`[data-open-children]`)?.addEventListener("click",()=>navigate("children"));
    $$(`[data-dashboard-view]`).forEach(button=>button.onclick=()=>navigate(button.dataset.dashboardView));
    if(currentRole==="principal")await bindPrincipalSignaturePanel(signatureRecord);
  }
  function headteacherSignaturePanel(record) {
    if(!record?.linked)return `<section class="panel signature-panel"><div class="panel-header"><div><h3>Digital Signature</h3><p>Principal report signing</p></div></div><div class="panel-body"><div class="empty"><strong>No linked principal record</strong><span>${esc(record?.error||"Ask the System Administrator to link this account to a principal record in Users and Access.")}</span></div></div></section>`;
    return `<section class="panel signature-panel"><div class="panel-header"><div><h3>Digital Signature</h3><p>Uploaded signature appears on officially published student report cards</p></div><span class="status ${record.signature_path?"published":"draft"}">${record.signature_path?"Signature ready":"Not uploaded"}</span></div>
      <div class="panel-body signature-layout"><div class="signature-preview-wrap">${record.signature_path?`<img id="headteacherSignaturePreview" alt="Principal signature">`:`<div class="signature-empty">No signature uploaded</div>`}</div>
      <div class="form-stack"><div><strong>${esc(record.full_name||"Principal")}</strong><p class="muted">Use a clear PNG, JPEG or WebP signature. A transparent PNG gives the best result.</p></div>
      <label class="field"><span>Signature image</span><input id="headteacherSignatureFile" type="file" accept="image/png,image/jpeg,image/webp"></label>
      <div class="button-row"><button class="button primary" id="headteacherSignatureUpload" type="button">Upload signature</button>${record.signature_path?`<button class="button danger" id="headteacherSignatureRemove" type="button">Remove signature</button>`:""}</div></div></div></section>`;
  }
  async function bindPrincipalSignaturePanel(record) {
    if(!record?.linked)return;
    if(record.signature_path&&byId("headteacherSignaturePreview")){
      try{byId("headteacherSignaturePreview").src=await signedUrl(CONFIG.signatureBucket,record.signature_path,900)}catch(_){byId("headteacherSignaturePreview").replaceWith(Object.assign(document.createElement("div"),{className:"signature-empty",textContent:"Signature preview unavailable"}))}
    }
    byId("headteacherSignatureUpload")?.addEventListener("click",async()=>{
      const file=byId("headteacherSignatureFile")?.files?.[0],button=byId("headteacherSignatureUpload");
      if(!file){toast("Signature not uploaded","Select a signature image first.","error");return}
      if(file.size>5*1024*1024){toast("Signature not uploaded","The image must be 5 MB or smaller.","error");return}
      button.disabled=true;button.textContent="Uploading";let uploadedPath="";
      try{
        const blob=await prepareSignatureImage(file),path=`${state.boot.profile.id}/${Date.now()}.webp`;uploadedPath=path;
        const {error}=await state.client.storage.from(CONFIG.signatureBucket).upload(path,blob,{contentType:"image/webp",upsert:false});if(error)throw error;
        await rpc("set_my_headteacher_signature",{target_signature_path:path,expected_updated_at:record.updated_at||null});
        if(record.signature_path&&record.signature_path!==path)await state.client.storage.from(CONFIG.signatureBucket).remove([record.signature_path]).catch(()=>{});
        state.signatureUrls.clear();toast("Digital signature uploaded");await renderDashboard(state.viewToken);
      }catch(error){if(uploadedPath)await state.client.storage.from(CONFIG.signatureBucket).remove([uploadedPath]).catch(()=>{});toast("Signature not uploaded",friendlyError(error),"error",6500)}
      finally{button.disabled=false;button.textContent="Upload signature"}
    });
    byId("headteacherSignatureRemove")?.addEventListener("click",async()=>{
      if(!await confirmAction("Remove Digital Signature","Published PDF files already generated remain unchanged. Future report cards will not show this signature.","Remove",true))return;
      try{await rpc("set_my_headteacher_signature",{target_signature_path:"",expected_updated_at:record.updated_at||null});if(record.signature_path)await state.client.storage.from(CONFIG.signatureBucket).remove([record.signature_path]).catch(()=>{});state.signatureUrls.clear();toast("Digital signature removed");await renderDashboard(state.viewToken)}
      catch(error){toast("Signature not removed",friendlyError(error),"error",6500)}
    });
  }
  async function prepareSignatureImage(file,maxWidth=1200,maxHeight=420) {
    const bitmap=await createImageBitmap(file),scale=Math.min(1,maxWidth/bitmap.width,maxHeight/bitmap.height);
    const canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    const ctx=canvas.getContext("2d",{willReadFrequently:true});ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
    const image=ctx.getImageData(0,0,canvas.width,canvas.height),data=image.data;let minX=canvas.width,minY=canvas.height,maxX=-1,maxY=-1;
    for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){const i=(y*canvas.width+x)*4,r=data[i],g=data[i+1],b=data[i+2],brightness=(r+g+b)/3;if(brightness>248)data[i+3]=0;else if(brightness>225)data[i+3]=Math.round(data[i+3]*(248-brightness)/23);if(data[i+3]>18){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y)}}
    ctx.putImageData(image,0,0);if(maxX<minX||maxY<minY)throw new Error("The selected image does not contain a visible signature");
    const pad=18,x=Math.max(0,minX-pad),y=Math.max(0,minY-pad),w=Math.min(canvas.width-x,maxX-minX+1+pad*2),h=Math.min(canvas.height-y,maxY-minY+1+pad*2);
    const cropped=document.createElement("canvas");cropped.width=w;cropped.height=h;cropped.getContext("2d").drawImage(canvas,x,y,w,h,0,0,w,h);
    return new Promise((resolve,reject)=>cropped.toBlob(blob=>blob?resolve(blob):reject(new Error("Signature conversion failed")),"image/webp",.92));
  }
  function dashboardQuickActions(currentRole) {
    const actions=[];
    if(currentRole==="class_teacher")actions.push(`<button class="button secondary" data-dashboard-view="my_class">My Class</button>`);
    if(currentRole==="subject_teacher")actions.push(`<button class="button secondary" data-dashboard-view="my_subjects">My Subjects</button>`);
    if(can("manage_students"))actions.push(`<button class="button secondary" data-dashboard-view="students">Students</button>`);
    if(can("manage_teachers"))actions.push(`<button class="button secondary" data-dashboard-view="teachers">Teachers</button>`);
    if(can("manage_headteachers"))actions.push(`<button class="button secondary" data-dashboard-view="headteachers">Principals</button>`);
    if(can("create_reports"))actions.push(`<button class="button primary" data-dashboard-view="reports">Report Cards</button>`);
    if(currentRole==="parent_guardian")actions.push(`<button class="button primary" data-dashboard-view="children">My Children</button>`);
    return actions.join("");
  }
  async function loadRoleWorkspace(force=false) {
    if(force||!state.workspace)state.workspace=await rpc("get_role_workspace");
    return state.workspace||{classes:[],subjects:[]};
  }
  function workspaceProgress(done,total) {
    const safeTotal=Number(total||0),safeDone=Number(done||0);
    return safeTotal?Math.max(0,Math.min(100,Math.round(safeDone/safeTotal*100))):0;
  }
  async function renderMyClass(token,force=false) {
    const data=await loadRoleWorkspace(force);if(token!==state.viewToken)return;
    const classes=data.classes||[];
    byId("content").innerHTML=`<div class="page-head"><div><h3>My Class</h3><p>Assigned learners, subjects, and report completion</p></div></div>
      ${classes.length?`<div class="grid two">${classes.map(item=>{const completion=workspaceProgress(item.completed_reports,item.expected_reports);return `<section class="panel pad">
        <div class="panel-header"><div><h3>${esc(item.class_name)}</h3><p>${number(item.student_count)} learners • ${number(item.subject_count)} subjects</p></div><span class="status ${completion===100?"published":"draft"}">${completion}% complete</span></div>
        <div class="metric-row"><div class="metric"><span>Draft or returned</span><strong>${number(item.open_reports)}</strong></div><div class="metric"><span>In review</span><strong>${number(item.review_reports)}</strong></div><div class="metric"><span>Published</span><strong>${number(item.published_reports)}</strong></div></div>
        <div class="progress"><span style="width:${completion}%"></span></div><div class="button-row" style="margin-top:15px"><button class="button secondary small" data-workspace-students="${attr(item.class_id)}">Students</button><button class="button primary small" data-workspace-reports="${attr(item.class_id)}">Report Cards</button></div></section>`}).join("")}</div>`:`<section class="panel pad"><div class="empty"><strong>No assigned class</strong></div></section>`}`;
    $$('[data-workspace-students]').forEach(button=>button.onclick=()=>{state.studentClassFilter=button.dataset.workspaceStudents;navigate("students")});
    $$('[data-workspace-reports]').forEach(button=>button.onclick=()=>{state.reportClassFilter=button.dataset.workspaceReports;navigate("reports")});
  }
  async function renderMySubjects(token,force=false) {
    const data=await loadRoleWorkspace(force);if(token!==state.viewToken)return;
    const subjects=data.subjects||[];
    byId("content").innerHTML=`<div class="page-head"><div><h3>My Subjects</h3><p>Assigned classes and assessment workload</p></div></div><section class="panel"><div class="table-wrap"><table><thead><tr><th>Class</th><th>Subject</th><th>Learners</th><th>Open reports</th><th>Scored</th><th>Progress</th><th></th></tr></thead><tbody>
      ${subjects.length?subjects.map(item=>{const completion=workspaceProgress(item.scored_reports,item.expected_reports);return `<tr><td><strong>${esc(item.class_name)}</strong></td><td><div class="cell-copy"><strong>${esc(item.subject_name)}</strong><small>${esc(item.subject_code||"")}</small></div></td><td>${number(item.student_count)}</td><td>${number(item.open_reports)}</td><td>${number(item.scored_reports)} / ${number(item.expected_reports)}</td><td><div class="bar-track"><span style="width:${completion}%"></span></div><small>${completion}%</small></td><td><button class="button primary small" data-subject-reports="${attr(item.class_id)}">Report Cards</button></td></tr>`}).join(""):`<tr><td colspan="7"><div class="empty"><strong>No assigned subjects</strong></div></td></tr>`}
      </tbody></table></div></section>`;
    $$('[data-subject-reports]').forEach(button=>button.onclick=()=>{state.reportClassFilter=button.dataset.subjectReports;navigate("reports")});
  }
  function statCard(colour,icon,label,value) {
    const display=typeof value==="string"?value:number(value);
    return `<article class="stat-card"><div class="stat-icon ${colour}">${icon}</div><div><span>${esc(label)}</span><strong>${esc(display)}</strong></div></article>`;
  }
  function canRemoveReportRow(row) {
    if(!can("remove_reports")||row?.archived)return false;
    const currentRole=role(),status=String(row?.status||"draft");
    if(currentRole==="system_admin")return true;
    return ["class_teacher","subject_teacher"].includes(currentRole)&&["draft","returned"].includes(status);
  }
  function reportTable(rows,compact=false,manage=false) {
    if(!rows.length)return `<div class="empty"><strong>No report cards</strong><span>Records will appear here when available.</span></div>`;
    return `<div class="table-wrap"><table><thead><tr>
      <th>Student</th><th>Class</th><th>Term</th><th>Average</th><th>Status</th><th>Updated</th>${compact?"":"<th></th>"}
      </tr></thead><tbody>${rows.map(row=>`<tr>
      <td><div class="cell-copy"><strong>${esc(row.student_name)}</strong><small>${esc(row.report_number||row.admission_no||"")}</small></div></td>
      <td>${esc(row.class_name)}</td><td>${esc(row.term_name||"")}</td><td><strong>${number(row.average,1)}%</strong></td>
      <td>${statusBadge(row.archived?"archived":row.status)}</td><td>${isoDateTime(row.updated_at)}</td>
      ${compact?"":`<td><div class="table-actions">
        ${!row.archived?`<button class="button secondary small" data-report-id="${attr(row.id)}">Open</button>`:""}
        ${manage&&canRemoveReportRow(row)?`<button class="button danger small" data-report-archive="${attr(row.id)}">Remove</button>`:""}
        ${manage&&can("restore_reports")&&row.archived?`<button class="button success small" data-report-restore="${attr(row.id)}">Restore</button>`:""}
      </div></td>`}
      </tr>`).join("")}</tbody></table></div>`;
  }

  async function renderStudents(token) {
    const content=byId("content");
    content.innerHTML=`
      <div class="page-head"><div><h3>Student Directory</h3><p>Secure student, guardian, and enrolment records</p></div>
        <div class="page-actions">
          ${can("manage_students")?`<button class="button outline" id="studentImport">Import CSV</button><button class="button outline" id="studentExport">Export CSV</button><button class="button primary" id="studentAdd">Add student</button>`:""}
        </div></div>
      <section class="panel">
        <div class="toolbar">
          <label class="search"><input id="studentSearch" type="search" placeholder="Search name or admission number"></label>
          <select id="studentClass">${optionList(state.boot.classes||[],"id","name",state.studentClassFilter||"","All classes")}</select>
          <select id="studentStatus"><option value="">All statuses</option><option value="active">Active</option><option value="graduated">Graduated</option><option value="withdrawn">Withdrawn</option><option value="suspended">Suspended</option></select>
          ${can("remove_students")?`<select id="studentArchive"><option value="active">Current records</option><option value="archived">Archived records</option><option value="all">All records</option></select>`:""}
        </div>
        <div id="studentResults"><div class="empty">Loading students</div></div>
      </section>`;
    byId("studentAdd")?.addEventListener("click",()=>openStudentEditor());
    byId("studentImport")?.addEventListener("click",openStudentImport);
    byId("studentExport")?.addEventListener("click",exportStudentsCsv);
    let timer;
    byId("studentSearch").addEventListener("input",()=>{clearTimeout(timer);timer=setTimeout(()=>{state.studentPage=1;loadStudentPage(token)},250)});
    byId("studentClass").addEventListener("change",()=>{state.studentPage=1;loadStudentPage(token)});
    byId("studentStatus").addEventListener("change",()=>{state.studentPage=1;loadStudentPage(token)});
    byId("studentArchive")?.addEventListener("change",()=>{state.studentPage=1;loadStudentPage(token)});
    await loadStudentPage(token);
  }
  async function loadStudentPage(token=state.viewToken) {
    const container=byId("studentResults");if(!container)return;
    container.innerHTML=`<div class="empty">Loading students</div>`;
    const data=await rpc("search_students_v5",{
      search_text:byId("studentSearch")?.value.trim()||"",
      target_class_id:byId("studentClass")?.value||null,
      target_status:byId("studentStatus")?.value||null,
      archive_filter:byId("studentArchive")?.value||"active",
      page_number:state.studentPage,page_size:CONFIG.pageSize
    });
    if(token!==state.viewToken||!byId("studentResults"))return;
    const rows=data.rows||[];
    container.innerHTML=rows.length?`
      <div class="table-wrap"><table><thead><tr><th>Student</th><th>Admission No.</th><th>Class</th><th>Academic Year</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.map(row=>`<tr>
        <td><div class="cell-main"><img class="thumb signed-photo" data-photo="${attr(row.photo_url||"")}" src="${CONFIG.logoPath}" alt="">
          <div class="cell-copy"><strong>${esc(fullName(row))}</strong><small>${esc(row.gender||"")} ${row.roll_number?`• Roll ${esc(row.roll_number)}`:""}</small></div></div></td>
        <td>${esc(row.admission_no)}</td><td>${esc(row.class_name||"—")}</td><td>${esc(row.academic_year_name||"—")}</td>
        <td>${statusBadge(row.archived?"archived":row.status)}</td><td><div class="table-actions">
          <button class="button secondary small" data-student-view="${attr(row.id)}">View</button>
          ${can("manage_students")&&!row.archived?`<button class="button ghost small" data-student-edit="${attr(row.id)}">Edit</button>`:""}
          ${row.enrollment_id&&!row.archived&&["class_teacher","subject_teacher"].includes(role())?`<button class="button outline small" data-student-report="${attr(row.enrollment_id)}">Report</button>`:""}
          ${can("remove_students")&&!row.archived?`<button class="button danger small" data-student-archive="${attr(row.id)}">Remove</button>`:""}
          ${can("remove_students")&&row.archived?`<button class="button success small" data-student-restore="${attr(row.id)}">Restore</button>`:""}
        </div></td></tr>`).join("")}</tbody></table></div>
      ${pagination(data.total,data.page,data.page_size,"student")}`:`<div class="empty"><strong>No students found</strong><span>The current filters returned no records.</span></div>`;
    resolveSignedPhotos(container);
    $$("[data-student-view]",container).forEach(btn=>btn.onclick=()=>openStudentRecord(btn.dataset.studentView));
    $$("[data-student-edit]",container).forEach(btn=>btn.onclick=()=>openStudentEditor(btn.dataset.studentEdit));
    $$("[data-student-report]",container).forEach(btn=>btn.onclick=()=>chooseTermForReport(btn.dataset.studentReport));
    $$("[data-student-archive]",container).forEach(btn=>btn.onclick=()=>archiveStudent(btn.dataset.studentArchive));
    $$("[data-student-restore]",container).forEach(btn=>btn.onclick=()=>restoreStudent(btn.dataset.studentRestore));
    bindPagination("student",data);
  }
  function pagination(total,page,pageSize,key) {
    const pages=Math.max(1,Math.ceil(Number(total||0)/Number(pageSize||CONFIG.pageSize)));
    const start=total?((page-1)*pageSize+1):0,end=Math.min(page*pageSize,total);
    return `<div class="pagination"><small>${number(start)}–${number(end)} of ${number(total)}</small><div class="pager">
      <button class="button ghost small" data-page-key="${key}" data-page="${page-1}" ${page<=1?"disabled":""}>Previous</button>
      <button class="button ghost small" data-page-key="${key}" data-page="${page+1}" ${page>=pages?"disabled":""}>Next</button>
    </div></div>`;
  }
  function bindPagination(key,data) {
    $$(`[data-page-key="${key}"]`).forEach(button=>button.onclick=()=>{
      const page=Number(button.dataset.page);if(page<1)return;
      if(key==="student"){state.studentPage=page;loadStudentPage()}
      if(key==="teacher"){state.teacherPage=page;loadTeacherPage()}
      if(key==="principal"){state.headteacherPage=page;loadPrincipalPage()}
      if(key==="report"){state.reportPage=page;loadReportPage()}
    });
  }
  async function resolveSignedPhotos(root=document) {
    await Promise.all($$(".signed-photo",root).map(async image=>{
      const path=image.dataset.photo;if(!path)return;
      try{image.src=await signedUrl(CONFIG.photoBucket,path)}catch(_){image.src=CONFIG.logoPath}
    }));
  }

  async function openStudentRecord(id) {
    const data=await run(()=>rpc("get_student_record_v5",{target_student_id:id}),{context:{student_id:id}});
    state.currentStudent=data;
    const student=data.student||{},enrolments=data.enrollments||[],guardians=data.guardians||[],reports=data.reports||[];
    modal(fullName(student),student.admission_no,`
      <div class="grid two">
        <div class="panel pad">
          <div class="cell-main"><img id="recordPhoto" class="preview-photo" src="${CONFIG.logoPath}" alt=""><div class="cell-copy">
            <strong>${esc(fullName(student))}</strong><small>${esc(student.gender)} • ${isoDate(student.date_of_birth)}</small>
            <small>${statusBadge(student.archived?"archived":student.status)}</small></div></div>
          <div class="hr"></div><div class="section-title"><h4>Guardians</h4></div>
          ${guardians.length?guardians.map(g=>`<div class="metric"><strong>${esc(g.full_name)}</strong><span>${esc(g.relationship)} • ${esc(g.phone||"No phone")} • ${esc(g.email||"No email")}</span></div>`).join(""):`<p class="help-text">No guardian record</p>`}
        </div>
        <div class="panel pad"><div class="section-title"><h4>Enrolment History</h4></div>
          ${enrolments.length?enrolments.map(e=>`<div class="diff-row"><span>${esc(e.academic_year_name)} • ${esc(e.class_name)}</span><b>${e.active?"Active":"Closed"}</b></div>`).join(""):`<p class="help-text">No enrolment record</p>`}
        </div>
      </div>
      <div class="section-title" style="margin-top:18px"><h4>Report Cards</h4></div>
      ${reportTable(reports)}
    `,can("manage_students")?`<div class="button-row">
      ${!student.archived?`<button class="button primary" id="recordEdit">Edit student</button>`:""}
      ${can("remove_students")&&!student.archived?`<button class="button danger" id="recordArchive">Remove student</button>`:""}
      ${can("remove_students")&&student.archived?`<button class="button success" id="recordRestore">Restore student</button>`:""}
    </div>`:"","wide");
    if(student.photo_url) signedUrl(CONFIG.photoBucket,student.photo_url).then(url=>{if(byId("recordPhoto"))byId("recordPhoto").src=url}).catch(()=>{});
    byId("recordEdit")?.addEventListener("click",()=>{closeModal();openStudentEditor(id)});
    byId("recordArchive")?.addEventListener("click",()=>{closeModal();archiveStudent(id)});
    byId("recordRestore")?.addEventListener("click",()=>{closeModal();restoreStudent(id)});
    $$("[data-report-id]",byId("modalBody")).forEach(btn=>btn.onclick=()=>{closeModal();openReportEditor(btn.dataset.reportId)});
  }

  async function archiveStudent(id) {
    const ok=await confirmAction("Remove Student","The student will be archived while historical reports remain preserved.","Remove",true);
    if(!ok)return;
    try{
      await rpc("archive_student",{target_student_id:id,reason_text:"Student removed from active records"});
      state.workspace=null;toast("Student removed");await loadStudentPage();
    }catch(error){toast("Student not removed",friendlyError(error),"error")}
  }
  async function restoreStudent(id) {
    const ok=await confirmAction("Restore Student","The student will return to the current student directory.","Restore");
    if(!ok)return;
    try{
      await rpc("restore_student",{target_student_id:id,reason_text:"Student restored to active records"});
      state.workspace=null;toast("Student restored");await loadStudentPage();
    }catch(error){toast("Student not restored",friendlyError(error),"error")}
  }

  async function openStudentEditor(id=null) {
    let record={student:{status:"active",gender:"Male"},enrollments:[],guardians:[]};
    if(id) record=await run(()=>rpc("get_student_record_v5",{target_student_id:id}));
    try{state.guardianAccounts=await rpc("list_guardian_portal_accounts",{search_text:""})}catch(_){state.guardianAccounts=[]}
    const student=record.student||{},latest=record.enrollments?.[0]||{},guardian=record.guardians?.find(g=>g.is_primary)||record.guardians?.[0]||{};
    if(!id&&!student.admission_no){try{student.admission_no=await rpc("generate_school_identifier",{identifier_kind:"student"})}catch(_){student.admission_no=""}}
    const years=state.boot.academic_years||[],classes=state.boot.classes||[];
    modal(id?"Edit Student":"Add Student",id?student.admission_no:"",`
      <form id="studentForm" class="form-stack">
        <input type="hidden" name="id" value="${attr(student.id||"")}">
        <input type="hidden" name="updated_at" value="${attr(student.updated_at||"")}">
        <div class="form-grid three">
          <label class="field"><span>Admission number</span><input name="admission_no" value="${attr(student.admission_no||"")}" readonly></label>
          <label class="field"><span>First name</span><input name="first_name" value="${attr(student.first_name||"")}" required></label>
          <label class="field"><span>Middle name</span><input name="middle_name" value="${attr(student.middle_name||"")}"></label>
          <label class="field"><span>Last name</span><input name="last_name" value="${attr(student.last_name||"")}" required></label>
          <label class="field"><span>Gender</span><select name="gender">
            ${["Male","Female","Other"].map(v=>`<option ${v===student.gender?"selected":""}>${v}</option>`).join("")}</select></label>
          <label class="field"><span>Date of birth</span><input type="date" name="date_of_birth" value="${attr(student.date_of_birth||"")}"></label>
          <label class="field"><span>Status</span><select name="status">
            ${["active","graduated","withdrawn","suspended"].map(v=>`<option value="${v}" ${v===student.status?"selected":""}>${v.replaceAll("_"," ")}</option>`).join("")}</select></label>
          <label class="field"><span>Academic year</span><select name="academic_year_id">${optionList(years,"id","name",latest.academic_year_id||activeYear()?.id,"Select academic year")}</select></label>
          <label class="field"><span>Class</span><select name="class_id">${optionList(classes,"id","name",latest.class_id,"Select class")}</select></label>
          <label class="field"><span>Roll number</span><input type="number" min="1" name="roll_number" value="${attr(latest.roll_number||"")}"></label>
          <label class="field full"><span>Student photograph</span><input id="studentPhotoFile" type="file" accept="image/jpeg,image/png,image/webp"></label>
        </div>
        <div class="section-title"><h4>Primary Guardian</h4></div>
        <div class="form-grid three">
          <input type="hidden" name="guardian_id" value="${attr(guardian.id||"")}">
          <label class="field"><span>Full name</span><input name="guardian_name" value="${attr(guardian.full_name||student.guardian_name||"")}"></label>
          <label class="field"><span>Relationship</span><input name="relationship" value="${attr(guardian.relationship||"Guardian")}"></label>
          <label class="field"><span>Telephone</span><input name="guardian_phone" value="${attr(guardian.phone||student.guardian_phone||"")}"></label>
          <label class="field"><span>Email</span><input type="email" name="guardian_email" value="${attr(guardian.email||student.guardian_email||"")}"></label>
          <label class="field"><span>Portal account</span><select name="guardian_auth_user_id">${optionList((state.guardianAccounts||[]).map(item=>({...item,label:`${item.full_name}${item.email?` • ${item.email}`:""}`})),"id","label",guardian.auth_user_id,"No linked account")}</select></label>
          <label class="field"><span>Address</span><input name="guardian_address" value="${attr(guardian.address||"")}"></label>
          <label class="check-field"><input type="checkbox" name="guardian_notify" ${guardian.can_receive_notifications!==false?"checked":""}><span>Receive notifications</span></label>
        </div>
      </form>`,
      `<button class="button ghost" type="button" id="studentCancel">Cancel</button><button class="button primary" type="submit" form="studentForm" id="studentSave">Save student</button>`,"wide");
    byId("studentCancel").onclick=closeModal;
    byId("studentForm").addEventListener("submit",event=>{event.preventDefault();saveStudentForm(record)});
  }

  function formObject(form) {return Object.fromEntries(new FormData(form).entries())}
  async function saveStudentForm(record) {
    const form=byId("studentForm"),button=byId("studentSave");
    if(!form?.reportValidity()){toast("Student not saved","Complete the required student fields.","error");return}
    const values=formObject(form);if(Boolean(values.academic_year_id)!==Boolean(values.class_id)){toast("Student not saved","Academic year and class must be selected together.","error");return}
    button.disabled=true;button.textContent="Saving";
    const payload={
      student:{id:values.id,updated_at:values.updated_at,admission_no:values.admission_no.trim(),first_name:values.first_name.trim(),
        middle_name:(values.middle_name||"").trim(),last_name:values.last_name.trim(),gender:values.gender,
        date_of_birth:values.date_of_birth||"",status:values.status,photo_url:record.student?.photo_url||""},
      enrollment:values.academic_year_id&&values.class_id?{academic_year_id:values.academic_year_id,class_id:values.class_id,roll_number:values.roll_number||"",active:true}:{},
      guardian:{id:values.guardian_id,full_name:(values.guardian_name||"").trim(),relationship:(values.relationship||"Guardian").trim(),
        phone:(values.guardian_phone||"").trim(),email:(values.guardian_email||"").trim(),address:(values.guardian_address||"").trim(),
        auth_user_id:values.guardian_auth_user_id||"",is_primary:true,can_view_reports:true,
        can_receive_notifications:form.elements.guardian_notify.checked},
      reason:values.id?"Student record updated":"Student registered"
    };
    let saved;
    try {
      saved=await rpc("save_student",{payload});
    } catch(error) {
      await reportClientError(error,{source:"student_save",stage:"record"});
      toast("Student not saved",friendlyError(error),"error",6500);
      button.disabled=false;button.textContent="Save student";return;
    }

    let photoWarning="";
    const file=byId("studentPhotoFile")?.files?.[0];
    if(file) {
      let uploadedPhotoPath="";
      try {
        uploadedPhotoPath=await uploadStudentPhoto(saved.student.id,file);
        saved=await rpc("set_student_photo",{target_student_id:saved.student.id,target_photo_url:uploadedPhotoPath,expected_updated_at:saved.student.updated_at||null});
        uploadedPhotoPath="";
      } catch(error) {
        if(uploadedPhotoPath)await state.client.storage.from(CONFIG.photoBucket).remove([uploadedPhotoPath]).catch(()=>{});
        await reportClientError(error,{source:"student_save",stage:"photo",student_id:saved.student.id});
        photoWarning="The student record was saved, but the photograph was not updated.";
      }
    }

    state.workspace=null;closeModal();toast("Student record saved",photoWarning,photoWarning?"warning":"success",6500);
    try {
      state.boot=await rpc("get_bootstrap_data");
      await loadStudentPage();
    } catch(error) {
      await reportClientError(error,{source:"student_save",stage:"refresh",student_id:saved.student.id});
      toast("Student saved","Reload the page to display the latest record.","warning",6500);
    } finally {button.disabled=false;button.textContent="Save student"}
  }
  async function compressImage(file,maxSize=1000,quality=.84) {
    const bitmap=await createImageBitmap(file),scale=Math.min(1,maxSize/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement("canvas");canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);
    canvas.getContext("2d").drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
    return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error("Image conversion failed")),"image/webp",quality));
  }
  async function uploadStudentPhoto(studentId,file) {
    const blob=await compressImage(file),path=`${studentId}/${Date.now()}.webp`;
    const {error}=await state.client.storage.from(CONFIG.photoBucket).upload(path,blob,{contentType:"image/webp",upsert:false});
    if(error)throw error;
    return path;
  }
  function parseCsv(text) {
    const rows=[];let row=[],cell="",quoted=false;
    for(let i=0;i<text.length;i++){
      const ch=text[i],next=text[i+1];
      if(ch==='"'&&quoted&&next==='"'){cell+='"';i++}
      else if(ch==='"'){quoted=!quoted}
      else if(ch===","&&!quoted){row.push(cell);cell=""}
      else if((ch==="\n"||ch==="\r")&&!quoted){if(ch==="\r"&&next==="\n")i++;row.push(cell);cell="";if(row.some(v=>v.trim()))rows.push(row);row=[]}
      else cell+=ch;
    }
    row.push(cell);if(row.some(v=>v.trim()))rows.push(row);
    if(rows.length<2)return[];
    const headers=rows[0].map(h=>h.trim().toLowerCase().replace(/\s+/g,"_"));
    return rows.slice(1).map(values=>Object.fromEntries(headers.map((h,i)=>[h,(values[i]||"").trim()])));
  }
  function openStudentImport() {
    modal("Import Students","CSV student registration",`
      <form id="studentImportForm" class="form-stack">
        <div class="form-grid">
          <label class="field"><span>Academic year</span><select name="academic_year_id" required>${optionList(state.boot.academic_years||[],"id","name",activeYear()?.id)}</select></label>
          <label class="field"><span>Class</span><select name="class_id" required>${optionList(state.boot.classes||[],"id","name")}</select></label>
        </div>
        <label class="file-drop"><strong>CSV file</strong><input name="file" type="file" accept=".csv,text/csv" required></label>
      </form>`,
      `<button class="button ghost" id="importCancel" type="button">Cancel</button><button class="button primary" id="importRun" type="button">Import</button>`,"small");
    byId("importCancel").onclick=closeModal;
    byId("importRun").onclick=async()=>{
      const form=byId("studentImportForm"),file=form.elements.file.files[0];if(!file)return;
      const values=formObject(form),rows=parseCsv(await file.text()).map(row=>({...row,academic_year_id:values.academic_year_id,class_id:values.class_id}));
      const button=byId("importRun");button.disabled=true;
      try {
        const result=await rpc("bulk_import_students",{rows,filename:file.name});
        closeModal();toast("Import completed",`${result.successful} saved, ${result.failed} failed`,result.failed?"warning":"success",7000);
        await loadStudentPage();
      } catch(error){toast("Import unsuccessful",friendlyError(error),"error")}
      finally{button.disabled=false}
    };
  }
  async function exportStudentsCsv() {
    const data=await rpc("search_students_v5",{search_text:byId("studentSearch")?.value||"",target_class_id:byId("studentClass")?.value||null,
      target_status:byId("studentStatus")?.value||null,archive_filter:byId("studentArchive")?.value||"active",page_number:1,page_size:100});
    const headers=["admission_no","first_name","middle_name","last_name","gender","date_of_birth","status","class_name","academic_year_name","roll_number"];
    downloadText("students.csv",[headers.join(","),...(data.rows||[]).map(row=>headers.map(h=>csvCell(row[h])).join(","))].join("\n"),"text/csv");
  }
  const csvCell=value=>`"${String(value??"").replaceAll('"','""')}"`;
  function downloadText(filename,text,type="text/plain") {
    const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement("a");a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function chooseTermForReport(enrollmentId) {
    const enrollmentYear=(state.currentStudent?.enrollments||[]).find(e=>e.id===enrollmentId)?.academic_year_id;
    const terms=(state.boot.terms||[]).filter(t=>!enrollmentYear||t.academic_year_id===enrollmentYear);
    modal("Select Term","Create or open a report card",`<label class="field"><span>Term</span><select id="reportTermChoice">${optionList(terms,"id","name",activeTerm()?.id)}</select></label>`,
      `<button class="button ghost" id="termCancel" type="button">Cancel</button><button class="button primary" id="termOpen" type="button">Open report</button>`,"small");
    byId("termCancel").onclick=closeModal;
    byId("termOpen").onclick=()=>{const termId=byId("reportTermChoice").value;if(termId){closeModal();openReportEditor(null,enrollmentId,termId)}};
  }


  async function renderAcademics(token) {
    const data=await rpc("get_academic_configuration");
    if(token!==state.viewToken)return;
    state.academic=data;
    byId("content").innerHTML=`
      <div class="page-head"><div><h3>Academic Configuration</h3><p>Periods, classes, subjects, assessment, and promotion</p></div></div>
      <div class="tabs">
        ${[["periods","Academic Periods"],["classes","Classes and Subjects"],["assessment","Assessment Schemes"],["grading","Grading Scales"],["promotion","Class Promotion"]].map(([id,label])=>
          `<button class="tab ${state.academicTab===id?"active":""}" data-academic-tab="${id}">${label}</button>`).join("")}
      </div>
      <div id="academicPanel"></div>`;
    $$("[data-academic-tab]").forEach(button=>button.onclick=()=>{state.academicTab=button.dataset.academicTab;renderAcademicTab()});
    renderAcademicTab();
  }
  function renderAcademicTab() {
    const target=byId("academicPanel");if(!target)return;
    const renderers={periods:renderPeriodsTab,classes:renderClassesTab,assessment:renderAssessmentTab,grading:renderGradingTab,promotion:renderPromotionTab};
    target.innerHTML=renderers[state.academicTab]();
    bindAcademicTabEvents();
  }
  function renderPeriodsTab() {
    const y=state.academic.academic_years||[],terms=state.academic.terms||[];
    return `<div class="grid two">
      <section class="panel"><div class="panel-header"><div><h3>Academic Years</h3><p>${y.length} configured</p></div><button class="button primary small" id="addYear">Add year</button></div>
        <div class="table-wrap"><table><thead><tr><th>Name</th><th>Dates</th><th>Status</th><th></th></tr></thead><tbody>
          ${y.map(row=>`<tr><td><strong>${esc(row.name)}</strong></td><td>${isoDate(row.start_date)} – ${isoDate(row.end_date)}</td>
            <td>${row.is_active?`<span class="status published">Active</span>`:`<span class="status draft">Inactive</span>`}</td>
            <td><div class="table-actions"><button class="button ghost small" data-edit-year="${row.id}">Edit</button>${!row.is_active?`<button class="button danger small" data-remove-year="${row.id}">Remove</button>`:""}</div></td></tr>`).join("")}
        </tbody></table></div></section>
      <section class="panel"><div class="panel-header"><div><h3>Terms</h3><p>${terms.length} configured</p></div><button class="button primary small" id="addTerm">Add term</button></div>
        <div class="table-wrap"><table><thead><tr><th>Term</th><th>Academic Year</th><th>Status</th><th></th></tr></thead><tbody>
          ${terms.map(row=>`<tr><td><div class="cell-copy"><strong>${esc(row.name)}</strong><small>${isoDate(row.start_date)} – ${isoDate(row.end_date)}</small></div></td>
            <td>${esc(y.find(x=>x.id===row.academic_year_id)?.name||"")}</td>
            <td>${row.is_active?`<span class="status published">Active</span>`:`<span class="status draft">Inactive</span>`}</td>
            <td><div class="table-actions"><button class="button ghost small" data-edit-term="${row.id}">Edit</button>
            ${!row.is_active?`<button class="button success small" data-set-active="${row.academic_year_id}|${row.id}">Activate</button><button class="button danger small" data-remove-term="${row.id}">Remove</button>`:""}</div></td></tr>`).join("")}
        </tbody></table></div></section>
    </div>`;
  }
  function renderClassesTab() {
    const classes=state.academic.classes||[],subjects=state.academic.subjects||[],assignments=state.academic.class_subjects||[];
    return `<div class="grid two">
      <section class="panel"><div class="panel-header"><div><h3>Classes</h3><p>${classes.length} configured</p></div><button class="button primary small" id="addClass">Add class</button></div>
        <div class="table-wrap"><table><thead><tr><th>Class</th><th>Level</th><th>Class Teacher</th><th></th></tr></thead><tbody>
          ${classes.map(row=>`<tr><td><strong>${esc(row.name)}</strong></td><td>${number(row.level_order)}</td>
            <td>${esc((state.academic.profiles||[]).find(p=>p.id===row.class_teacher_id)?.full_name||"—")}</td>
            <td><div class="table-actions"><button class="button ghost small" data-edit-class="${row.id}">Edit</button><button class="button danger small" data-remove-class="${row.id}">Remove</button></div></td></tr>`).join("")}
        </tbody></table></div></section>
      <section class="panel"><div class="panel-header"><div><h3>Subjects</h3><p>${subjects.length} configured</p></div><button class="button primary small" id="addSubject">Add subject</button></div>
        <div class="table-wrap"><table><thead><tr><th>Code</th><th>Subject</th><th>Order</th><th></th></tr></thead><tbody>
          ${subjects.map(row=>`<tr><td><strong>${esc(row.code)}</strong></td><td>${esc(row.name)}</td><td>${number(row.display_order)}</td>
            <td><div class="table-actions"><button class="button ghost small" data-edit-subject="${row.id}">Edit</button><button class="button danger small" data-remove-subject="${row.id}">Remove</button></div></td></tr>`).join("")}
        </tbody></table></div></section>
      <section class="panel" style="grid-column:1/-1"><div class="panel-header"><div><h3>Class Subject Assignments</h3><p>${assignments.filter(x=>x.active).length} active assignments</p></div>
        <button class="button primary small" id="addAssignment">Assign subject</button></div>
        <div class="table-wrap"><table><thead><tr><th>Class</th><th>Subject</th><th>Teacher</th><th>Status</th><th></th></tr></thead><tbody>
          ${assignments.map(row=>`<tr><td>${esc(row.class_name)}</td><td>${esc(row.subject_name)}</td><td>${esc(row.teacher_name||"—")}</td>
            <td>${row.active?`<span class="status published">Active</span>`:`<span class="status withdrawn">Inactive</span>`}</td>
            <td><div class="table-actions"><button class="button ghost small" data-edit-assignment="${row.id}">Edit</button>${row.active?`<button class="button danger small" data-remove-assignment="${row.id}">Remove</button>`:`<button class="button danger small" data-delete-assignment="${row.id}">Delete</button>`}</div></td></tr>`).join("")}
        </tbody></table></div></section>
    </div>`;
  }
  function renderAssessmentTab() {
    const schemes=state.academic.assessment_schemes||[];
    return `<section class="panel"><div class="panel-header"><div><h3>Assessment Schemes</h3><p>Weighted components by academic scope</p></div>
      <button class="button primary small" id="addScheme">Add scheme</button></div>
      <div class="table-wrap"><table><thead><tr><th>Scheme</th><th>Scope</th><th>Components</th><th>Weight</th><th>Status</th><th></th></tr></thead><tbody>
        ${schemes.map(row=>`<tr><td><strong>${esc(row.name)}</strong></td><td>${esc(schemeScope(row))}</td>
          <td>${(row.components||[]).map(c=>`<span class="chip">${esc(c.code)} ${number(c.weight,1)}%</span>`).join(" ")}</td>
          <td><strong>${number(row.total_weight,1)}%</strong></td><td>${row.active?`<span class="status published">Active</span>`:`<span class="status draft">Inactive</span>`}</td>
          <td><button class="button ghost small" data-edit-scheme="${row.id}">Edit</button></td></tr>`).join("")}
      </tbody></table></div></section>`;
  }
  function schemeScope(row) {
    const names=[];
    if(row.academic_year_id)names.push((state.academic.academic_years||[]).find(x=>x.id===row.academic_year_id)?.name);
    if(row.term_id)names.push((state.academic.terms||[]).find(x=>x.id===row.term_id)?.name);
    if(row.class_id)names.push((state.academic.classes||[]).find(x=>x.id===row.class_id)?.name);
    if(row.subject_id)names.push((state.academic.subjects||[]).find(x=>x.id===row.subject_id)?.name);
    return names.filter(Boolean).join(" • ")||"School-wide";
  }
  function renderGradingTab() {
    const scales=state.academic.grading_scales||[];
    return `<section class="panel"><div class="panel-header"><div><h3>Grading Scales</h3><p>Scope-aware grade ranges and points</p></div>
      <button class="button primary small" id="addGrade">Add grade</button></div>
      <div class="table-wrap"><table><thead><tr><th>Grade</th><th>Range</th><th>Remark</th><th>Point</th><th>Scope</th><th></th></tr></thead><tbody>
        ${scales.map(row=>`<tr><td><strong>${esc(row.grade)}</strong></td><td>${number(row.min_mark,2)}–${number(row.max_mark,2)}</td>
          <td>${esc(row.remark)}</td><td>${number(row.grade_point,2)}</td><td>${esc(gradeScope(row))}</td>
          <td><div class="table-actions"><button class="button ghost small" data-edit-grade="${row.id}">Edit</button>
            <button class="button danger small" data-delete-grade="${row.id}">Remove</button></div></td></tr>`).join("")}
      </tbody></table></div></section>`;
  }
  function gradeScope(row) {
    return [
      (state.academic.academic_years||[]).find(x=>x.id===row.academic_year_id)?.name,
      (state.academic.classes||[]).find(x=>x.id===row.class_id)?.name,
      (state.academic.subjects||[]).find(x=>x.id===row.subject_id)?.name
    ].filter(Boolean).join(" • ")||"School-wide";
  }
  function renderPromotionTab() {
    return `<section class="panel pad"><div class="page-head"><div><h3>Class Promotion</h3><p>Create next-year enrolments as one controlled operation</p></div></div>
      <form id="promotionForm" class="form-grid">
        <label class="field"><span>Source academic year</span><select name="source_year" required>${optionList(state.academic.academic_years||[],"id","name",activeYear()?.id)}</select></label>
        <label class="field"><span>Source class</span><select name="source_class" required>${optionList(state.academic.classes||[],"id","name")}</select></label>
        <label class="field"><span>Target academic year</span><select name="target_year" required>${optionList(state.academic.academic_years||[],"id","name")}</select></label>
        <label class="field"><span>Target class</span><select name="target_class" required>${optionList(state.academic.classes||[],"id","name")}</select></label>
        <div class="full"><button class="button primary" id="runPromotion" type="button">Promote class</button></div>
      </form></section>`;
  }
  function bindAcademicTabEvents() {
    byId("addYear")?.addEventListener("click",()=>openYearEditor());
    $$("[data-edit-year]").forEach(b=>b.onclick=()=>openYearEditor(b.dataset.editYear));
    $$("[data-remove-year]").forEach(b=>b.onclick=()=>removeAcademicEntity("academic_year",b.dataset.removeYear));
    byId("addTerm")?.addEventListener("click",()=>openTermEditor());
    $$("[data-edit-term]").forEach(b=>b.onclick=()=>openTermEditor(b.dataset.editTerm));
    $$("[data-remove-term]").forEach(b=>b.onclick=()=>removeAcademicEntity("term",b.dataset.removeTerm));
    $$("[data-set-active]").forEach(b=>b.onclick=async()=>{
      const [yearId,termId]=b.dataset.setActive.split("|");
      if(await confirmAction("Activate Academic Period","This term will become the current reporting period.","Activate")){
        await run(()=>rpc("set_active_period",{target_academic_year_id:yearId,target_term_id:termId}),{success:"Academic period activated"});
        state.boot=await rpc("get_bootstrap_data");await renderAcademics(state.viewToken,true);
      }
    });
    byId("addClass")?.addEventListener("click",()=>openClassEditor());
    $$("[data-edit-class]").forEach(b=>b.onclick=()=>openClassEditor(b.dataset.editClass));
    $$("[data-remove-class]").forEach(b=>b.onclick=()=>removeAcademicEntity("class",b.dataset.removeClass));
    byId("addSubject")?.addEventListener("click",()=>openSubjectEditor());
    $$("[data-edit-subject]").forEach(b=>b.onclick=()=>openSubjectEditor(b.dataset.editSubject));
    $$("[data-remove-subject]").forEach(b=>b.onclick=()=>removeAcademicEntity("subject",b.dataset.removeSubject));
    byId("addAssignment")?.addEventListener("click",()=>openAssignmentEditor());
    $$("[data-edit-assignment]").forEach(b=>b.onclick=()=>openAssignmentEditor(b.dataset.editAssignment));
    $$("[data-remove-assignment]").forEach(b=>b.onclick=()=>removeAcademicEntity("assignment",b.dataset.removeAssignment));
    $$("[data-delete-assignment]").forEach(b=>b.onclick=()=>deleteClassSubjectAssignment(b.dataset.deleteAssignment));
    byId("addScheme")?.addEventListener("click",()=>openSchemeEditor());
    $$("[data-edit-scheme]").forEach(b=>b.onclick=()=>openSchemeEditor(b.dataset.editScheme));
    byId("addGrade")?.addEventListener("click",()=>openGradeEditor());
    $$("[data-edit-grade]").forEach(b=>b.onclick=()=>openGradeEditor(b.dataset.editGrade));
    $$("[data-delete-grade]").forEach(b=>b.onclick=()=>removeGrade(b.dataset.deleteGrade));
    byId("runPromotion")?.addEventListener("click",runPromotion);
  }
  async function removeAcademicEntity(type,id) {
    const labels={academic_year:"Academic year",term:"Term",class:"Class",subject:"Subject",assignment:"Subject assignment"};
    const messages={academic_year:"The academic year and its terms will be removed from current configuration. Published historical reports remain preserved.",term:"The term will be removed from current configuration. Published historical reports remain preserved."};
    const ok=await confirmAction(`Remove ${labels[type]||"Record"}`,messages[type]||"The record will be archived while historical academic results remain preserved.","Remove",true);
    if(!ok)return;
    try{
      await rpc("archive_academic_entity",{entity_type:type,target_id:id,reason_text:`${labels[type]||"Academic record"} removed`});
      toast(`${labels[type]||"Academic record"} removed`);await refreshAcademic();
    }catch(error){toast("Record not removed",friendlyError(error),"error",6500)}
  }

  async function deleteClassSubjectAssignment(id) {
    const row=(state.academic?.class_subjects||[]).find(item=>item.id===id);if(!row)return;
    const label=[row.class_name,row.subject_name].filter(Boolean).join(" • ")||"this assignment";
    const ok=await confirmAction("Delete Subject Assignment",`Permanently delete ${label}? This cannot be undone.`,"Delete",true);
    if(!ok)return;
    try{
      await rpc("delete_class_subject_assignment",{target_id:id,reason_text:"Class subject assignment permanently deleted"});
      toast("Subject assignment deleted");await refreshAcademic();
    }catch(error){toast("Assignment not deleted",friendlyError(error),"error",6500)}
  }

  async function refreshAcademic() {
    state.workspace=null;state.academic=await rpc("get_academic_configuration");
    state.boot=await rpc("get_bootstrap_data");
    renderAcademicTab();
  }
  function openYearEditor(id=null) {
    const row=(state.academic.academic_years||[]).find(x=>x.id===id)||{};
    modal(id?"Edit Academic Year":"Add Academic Year","",`<form id="entityForm" class="form-grid">
      <label class="field full"><span>Name</span><input name="name" value="${attr(row.name||"")}" required></label>
      <label class="field"><span>Start date</span><input type="date" name="start_date" value="${attr(row.start_date||"")}"></label>
      <label class="field"><span>End date</span><input type="date" name="end_date" value="${attr(row.end_date||"")}"></label>
    </form>`,`<button class="button ghost" id="entityCancel" type="button">Cancel</button><button class="button primary" id="entitySave" type="button">Save</button>`,"small");
    byId("entityCancel").onclick=closeModal;
    byId("entitySave").onclick=()=>saveEntity("academic_years",id);
  }
  function openTermEditor(id=null) {
    const row=(state.academic.terms||[]).find(x=>x.id===id)||{};
    modal(id?"Edit Term":"Add Term","",`<form id="entityForm" class="form-grid">
      <label class="field full"><span>Academic year</span><select name="academic_year_id" required>${optionList(state.academic.academic_years||[],"id","name",row.academic_year_id||activeYear()?.id)}</select></label>
      <label class="field"><span>Name</span><input name="name" value="${attr(row.name||"")}" required></label>
      <label class="field"><span>Sequence</span><input type="number" min="1" max="6" name="sequence" value="${attr(row.sequence||1)}" required></label>
      <label class="field"><span>Start date</span><input type="date" name="start_date" value="${attr(row.start_date||"")}"></label>
      <label class="field"><span>End date</span><input type="date" name="end_date" value="${attr(row.end_date||"")}"></label>
      <label class="field full"><span>Next term begins</span><input type="date" name="next_term_begins" value="${attr(row.next_term_begins||"")}"></label>
    </form>`,`<button class="button ghost" id="entityCancel" type="button">Cancel</button><button class="button primary" id="entitySave" type="button">Save</button>`,"small");
    byId("entityCancel").onclick=closeModal;byId("entitySave").onclick=()=>saveEntity("terms",id);
  }
  function openClassEditor(id=null) {
    const row=(state.academic.classes||[]).find(x=>x.id===id)||{};
    const classTeacherProfiles=(state.academic.profiles||[]).filter(profile=>profile.role==="class_teacher");
    modal(id?"Edit Class":"Add Class","",`<form id="entityForm" class="form-grid">
      <label class="field"><span>Name</span><input name="name" value="${attr(row.name||"")}" required></label>
      <label class="field"><span>Level order</span><input type="number" name="level_order" value="${attr(row.level_order||0)}"></label>
      <label class="field full"><span>Class teacher</span><select name="class_teacher_id">${optionList(classTeacherProfiles,"id","full_name",row.class_teacher_id,"Unassigned")}</select></label>
      <label class="check-field full"><input type="checkbox" name="active" ${row.active!==false?"checked":""}><span>Active class</span></label>
    </form>`,`<button class="button ghost" id="entityCancel" type="button">Cancel</button><button class="button primary" id="entitySave" type="button">Save</button>`,"small");
    byId("entityCancel").onclick=closeModal;byId("entitySave").onclick=()=>saveEntity("classes",id);
  }
  function openSubjectEditor(id=null) {
    const row=(state.academic.subjects||[]).find(x=>x.id===id)||{};
    modal(id?"Edit Subject":"Add Subject",id?"The unique subject code remains permanent.":"The code is generated automatically from the subject name.",`<form id="entityForm" class="form-grid">
      <label class="field"><span>Subject name</span><input name="name" value="${attr(row.name||"")}" required></label>
      <label class="field"><span>Unique code</span><input name="code" value="${attr(row.code||"")}" placeholder="Generated automatically" readonly></label>
      <label class="field"><span>Display order</span><input type="number" name="display_order" value="${attr(row.display_order||0)}"></label>
      <label class="check-field"><input type="checkbox" name="active" ${row.active!==false?"checked":""}><span>Active subject</span></label>
    </form>`,`<button class="button ghost" id="entityCancel" type="button">Cancel</button><button class="button primary" id="entitySave" type="button">Save</button>`,"small");
    const form=byId("entityForm"),nameInput=form.elements.name,codeInput=form.elements.code;
    if(!id){
      let timer;const generate=async()=>{const name=nameInput.value.trim();if(!name){codeInput.value="";return}try{codeInput.value=await rpc("generate_subject_code",{subject_name:name,exclude_subject_id:null})}catch(_){codeInput.value=""}};
      nameInput.addEventListener("input",()=>{clearTimeout(timer);codeInput.value="";codeInput.placeholder=`${subjectCodePrefix(nameInput.value)}####`;timer=setTimeout(generate,550)});
      nameInput.addEventListener("blur",generate);
    }
    byId("entityCancel").onclick=closeModal;byId("entitySave").onclick=()=>saveEntity("subjects",id);
  }
  function subjectCodePrefix(name) {
    const words=String(name||"").toUpperCase().replace(/[^A-Z0-9 ]/g," ").trim().split(/\s+/).filter(Boolean);
    const meaningful=words.filter(word=>!["AND","OF","THE","FOR","IN","TO"].includes(word)),source=meaningful.length?meaningful:words;
    if(!source.length)return "SUB";return source.length===1?source[0].slice(0,3):source.slice(0,4).map(word=>word[0]).join("");
  }
  async function saveEntity(table,id) {
    const form=byId("entityForm"),values=formObject(form),button=byId("entitySave");if(!form?.reportValidity())return;button.disabled=true;let saved=false;
    try {
      const numeric=["sequence","level_order","display_order"];
      numeric.forEach(key=>{if(key in values)values[key]=Number(values[key]||0)});
      ["start_date","end_date","next_term_begins","class_teacher_id"].forEach(key=>{if(key in values&&!values[key])values[key]=null});
      if("active" in form.elements)values.active=form.elements.active.checked;
      await rpc("save_academic_entity",{entity_type:table,payload:{...values,id:id||null,reason:id?"Academic record updated":"Academic record created"}});
      saved=true;state.workspace=null;closeModal();toast("Academic record saved");
      try{await refreshAcademic()}catch(refreshError){await reportClientError(refreshError,{source:"academic_save",entity_type:table,stage:"refresh"});toast("Record saved","Reload the page to display the latest record.","warning",6500)}
    } catch(error){await reportClientError(error,{source:"academic_save",entity_type:table,stage:saved?"refresh":"record"});toast(saved?"Record saved":"Record not saved",saved?"Reload the page to display the latest record.":friendlyError(error),saved?"warning":"error",6500)}
    finally{button.disabled=false}
  }
  function openAssignmentEditor(id=null) {
    const row=(state.academic.class_subjects||[]).find(x=>x.id===id)||{};
    const subjectTeacherProfiles=(state.academic.profiles||[]).filter(profile=>["class_teacher","subject_teacher"].includes(profile.role));
    modal(id?"Edit Subject Assignment":"Assign Subject","",`<form id="entityForm" class="form-grid">
      <label class="field"><span>Class</span><select name="class_id" required>${optionList(state.academic.classes||[],"id","name",row.class_id)}</select></label>
      <label class="field"><span>Subject</span><select name="subject_id" required>${optionList(state.academic.subjects||[],"id","name",row.subject_id)}</select></label>
      <label class="field full"><span>Teacher</span><select name="teacher_id">${optionList(subjectTeacherProfiles,"id","full_name",row.teacher_id,"Unassigned")}</select></label>
      <label class="check-field full"><input type="checkbox" name="active" ${row.active!==false?"checked":""}><span>Active assignment</span></label>
    </form>`,`<button class="button ghost" id="entityCancel" type="button">Cancel</button><button class="button primary" id="entitySave" type="button">Save</button>`,"small");
    byId("entityCancel").onclick=closeModal;
    byId("entitySave").onclick=async()=>{
      const form=byId("entityForm"),v=formObject(form),button=byId("entitySave");if(!form?.reportValidity())return;button.disabled=true;let saved=false;
      try{
        const record={id:id||null,class_id:v.class_id,subject_id:v.subject_id,teacher_id:v.teacher_id||null,active:form.elements.active.checked,reason:id?"Class subject assignment updated":"Class subject assigned"};
        await rpc("save_class_subject_assignment",{payload:record});saved=true;
        state.workspace=null;closeModal();toast("Assignment saved");
        try{await refreshAcademic()}catch(refreshError){await reportClientError(refreshError,{source:"assignment_save",stage:"refresh"});toast("Assignment saved","Reload the page to display the latest assignment.","warning",6500)}
      }catch(error){await reportClientError(error,{source:"assignment_save",stage:saved?"refresh":"record"});toast(saved?"Assignment saved":"Assignment not saved",saved?"Reload the page to display the latest assignment.":friendlyError(error),saved?"warning":"error",6500)}finally{button.disabled=false}
    };
  }
  function openSchemeEditor(id=null) {
    const row=(state.academic.assessment_schemes||[]).find(x=>x.id===id)||{components:[
      {name:"Continuous Assessment",code:"CA",maximum_score:30,weight:30,display_order:1,required:true},
      {name:"End of Term Examination",code:"EXAM",maximum_score:70,weight:70,display_order:2,required:true}
    ]};
    modal(id?"Edit Assessment Scheme":"Add Assessment Scheme",schemeScope(row),`<form id="schemeForm" class="form-stack">
      <div class="form-grid three">
        <input type="hidden" name="id" value="${attr(row.id||"")}">
        <label class="field"><span>Name</span><input name="name" value="${attr(row.name||"")}" required></label>
        <label class="field"><span>Academic year</span><select name="academic_year_id">${optionList(state.academic.academic_years||[],"id","name",row.academic_year_id,"All years")}</select></label>
        <label class="field"><span>Term</span><select name="term_id">${optionList(state.academic.terms||[],"id","name",row.term_id,"All terms")}</select></label>
        <label class="field"><span>Class</span><select name="class_id">${optionList(state.academic.classes||[],"id","name",row.class_id,"All classes")}</select></label>
        <label class="field"><span>Subject</span><select name="subject_id">${optionList(state.academic.subjects||[],"id","name",row.subject_id,"All subjects")}</select></label>
        <label class="check-field"><input type="checkbox" name="active" ${row.active!==false?"checked":""}><span>Active scheme</span></label>
      </div>
      <div class="section-title"><h4>Components</h4><button class="button secondary small" id="addComponent" type="button">Add component</button></div>
      <div id="componentRows"></div>
    </form>`,`<button class="button ghost" id="schemeCancel" type="button">Cancel</button><button class="button primary" id="schemeSave" type="button">Save scheme</button>`,"wide");
    state.schemeComponents=(row.components||[]).map(x=>({...x}));
    renderComponentRows();
    byId("addComponent").onclick=()=>{state.schemeComponents.push({name:"",code:"",maximum_score:100,weight:0,display_order:state.schemeComponents.length+1,required:true});renderComponentRows()};
    byId("schemeCancel").onclick=closeModal;byId("schemeSave").onclick=saveScheme;
  }
  function renderComponentRows() {
    const root=byId("componentRows");if(!root)return;
    root.innerHTML=state.schemeComponents.map((c,i)=>`<div class="form-grid three component-row" data-index="${i}" style="margin-bottom:12px">
      <label class="field"><span>Component name</span><input data-key="name" value="${attr(c.name||"")}" required></label>
      <label class="field"><span>Code</span><input data-key="code" value="${attr(c.code||"")}" required></label>
      <label class="field"><span>Maximum score</span><input data-key="maximum_score" type="number" min=".01" step=".01" value="${attr(c.maximum_score||0)}" required></label>
      <label class="field"><span>Weight (%)</span><input data-key="weight" type="number" min=".001" max="100" step=".001" value="${attr(c.weight||0)}" required></label>
      <label class="field"><span>Display order</span><input data-key="display_order" type="number" value="${attr(c.display_order||i+1)}"></label>
      <div class="button-row"><label class="check-field"><input data-key="required" type="checkbox" ${c.required!==false?"checked":""}><span>Required</span></label>
        <button class="button danger small" type="button" data-remove-component="${i}">Remove</button></div>
    </div>`).join("");
    $$(".component-row",root).forEach(row=>$$("[data-key]",row).forEach(input=>input.oninput=()=>{
      const item=state.schemeComponents[Number(row.dataset.index)],key=input.dataset.key;
      item[key]=input.type==="checkbox"?input.checked:input.type==="number"?Number(input.value):input.value;
    }));
    $$("[data-remove-component]",root).forEach(button=>button.onclick=()=>{state.schemeComponents.splice(Number(button.dataset.removeComponent),1);renderComponentRows()});
  }
  async function saveScheme() {
    const form=byId("schemeForm"),v=formObject(form),button=byId("schemeSave");if(!form?.reportValidity())return;button.disabled=true;let saved=false;
    try{
      const payload={id:v.id,name:v.name,academic_year_id:v.academic_year_id,term_id:v.term_id,class_id:v.class_id,subject_id:v.subject_id,
        active:form.elements.active.checked,components:state.schemeComponents,reason:v.id?"Assessment scheme updated":"Assessment scheme created"};
      await rpc("save_assessment_scheme",{payload});saved=true;closeModal();toast("Assessment scheme saved");
      try{await refreshAcademic()}catch(refreshError){await reportClientError(refreshError,{source:"assessment_scheme_save",stage:"refresh"});toast("Scheme saved","Reload the page to display the latest scheme.","warning",6500)}
    }catch(error){await reportClientError(error,{source:"assessment_scheme_save",stage:saved?"refresh":"record"});toast(saved?"Scheme saved":"Scheme not saved",saved?"Reload the page to display the latest scheme.":friendlyError(error),saved?"warning":"error",6500)}finally{button.disabled=false}
  }
  function openGradeEditor(id=null) {
    const row=(state.academic.grading_scales||[]).find(x=>x.id===id)||{};
    modal(id?"Edit Grade":"Add Grade","",`<form id="gradeForm" class="form-grid three">
      <label class="field"><span>Grade</span><input name="grade" value="${attr(row.grade||"")}" required></label>
      <label class="field"><span>Minimum mark</span><input type="number" min="0" max="100" step=".01" name="min_mark" value="${attr(row.min_mark??"")}" required></label>
      <label class="field"><span>Maximum mark</span><input type="number" min="0" max="100" step=".01" name="max_mark" value="${attr(row.max_mark??"")}" required></label>
      <label class="field"><span>Remark</span><input name="remark" value="${attr(row.remark||"")}" required></label>
      <label class="field"><span>Grade point</span><input type="number" step=".01" name="grade_point" value="${attr(row.grade_point||0)}"></label>
      <label class="field"><span>Display order</span><input type="number" name="display_order" value="${attr(row.display_order||0)}"></label>
      <label class="field"><span>Academic year</span><select name="academic_year_id">${optionList(state.academic.academic_years||[],"id","name",row.academic_year_id,"All years")}</select></label>
      <label class="field"><span>Class</span><select name="class_id">${optionList(state.academic.classes||[],"id","name",row.class_id,"All classes")}</select></label>
      <label class="field"><span>Subject</span><select name="subject_id">${optionList(state.academic.subjects||[],"id","name",row.subject_id,"All subjects")}</select></label>
    </form>`,`<button class="button ghost" id="gradeCancel" type="button">Cancel</button><button class="button primary" id="gradeSave" type="button">Save</button>`,"wide");
    byId("gradeCancel").onclick=closeModal;
    byId("gradeSave").onclick=async()=>{
      const form=byId("gradeForm");if(!form?.reportValidity())return;
      const v=formObject(form),record={id:id||null,grade:v.grade,remark:v.remark,min_mark:Number(v.min_mark),max_mark:Number(v.max_mark),
        grade_point:Number(v.grade_point||0),display_order:Number(v.display_order||0),academic_year_id:v.academic_year_id||null,class_id:v.class_id||null,subject_id:v.subject_id||null,reason:id?"Grading scale updated":"Grading scale created"};
      const button=byId("gradeSave");button.disabled=true;
      let saved=false;
      try{await rpc("save_grading_scale",{payload:record});saved=true;closeModal();toast("Grading scale saved");
        try{await refreshAcademic()}catch(refreshError){await reportClientError(refreshError,{source:"grading_scale_save",stage:"refresh"});toast("Grade saved","Reload the page to display the latest grading scale.","warning",6500)}}
      catch(error){await reportClientError(error,{source:"grading_scale_save",stage:saved?"refresh":"record"});toast(saved?"Grade saved":"Grade not saved",saved?"Reload the page to display the latest grading scale.":friendlyError(error),saved?"warning":"error",6500)}finally{button.disabled=false}
    };
  }
  async function removeGrade(id) {
    if(!await confirmAction("Remove Grade","The grade will no longer be used for future calculations.","Remove",true))return;
    await run(()=>rpc("archive_grading_scale",{target_grade_id:id,reason_text:"Grading scale removed"}),{success:"Grade removed"});
    await refreshAcademic();
  }
  async function runPromotion() {
    const form=byId("promotionForm"),v=formObject(form);
    if(!v.source_year||!v.source_class||!v.target_year||!v.target_class)return;
    if(!await confirmAction("Promote Class","Active students will receive enrolments in the selected target class.","Promote"))return;
    const result=await run(()=>rpc("bulk_promote_class",{source_academic_year_id:v.source_year,source_class_id:v.source_class,
      target_academic_year_id:v.target_year,target_class_id:v.target_class}),{success:"Class promotion completed"});
    toast("Promotion result",`${result.promoted} enrolments created or updated`);
  }


  async function renderReports(token) {
    state.reportEditor=null;
    byId("content").innerHTML=`
      <div class="page-head"><div><h3>Report Cards</h3><p>Transactional assessment, review, approval, and publication</p></div>
        <div class="page-actions">
          ${can("import_scores")?`<button class="button outline" id="scoreImport">Import scores</button>`:""}
          <button class="button outline" id="reportExport">Export list</button>
          ${can("create_reports")?`<button class="button primary" id="reportNew">New report</button>`:""}
        </div></div>
      <section class="panel">
        <div class="toolbar">
          <label class="search"><input id="reportSearch" type="search" placeholder="Search student or report number"></label>
          <select id="reportTerm">${optionList(state.boot.terms||[],"id","name",activeTerm()?.id,"All terms")}</select>
          <select id="reportClass">${optionList(state.boot.classes||[],"id","name",state.reportClassFilter||"","All classes")}</select>
          <select id="reportStatus"><option value="">All statuses</option>
            ${["draft","submitted","class_reviewed","approved","published","returned","withdrawn"].map(v=>`<option value="${v}">${v.replaceAll("_"," ")}</option>`).join("")}</select>
          ${can("remove_reports")?`<select id="reportArchive"><option value="active">Current reports</option><option value="archived">Removed reports</option><option value="all">All reports</option></select>`:""}
        </div>
        <div id="reportResults"><div class="empty">Loading report cards</div></div>
      </section>`;
    byId("reportNew")?.addEventListener("click",openNewReportPicker);
    byId("scoreImport")?.addEventListener("click",openScoreImport);
    byId("reportExport")?.addEventListener("click",exportReportList);
    let timer;
    byId("reportSearch").oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>{state.reportPage=1;loadReportPage(token)},250)};
    ["reportTerm","reportClass","reportStatus","reportArchive"].forEach(id=>{if(byId(id))byId(id).onchange=()=>{state.reportPage=1;loadReportPage(token)}});
    await loadReportPage(token);
  }
  async function loadReportPage(token=state.viewToken) {
    const root=byId("reportResults");if(!root)return;
    root.innerHTML=`<div class="empty">Loading report cards</div>`;
    const data=await rpc("list_report_cards_v6",{
      target_term_id:byId("reportTerm")?.value||null,target_class_id:byId("reportClass")?.value||null,
      target_status:byId("reportStatus")?.value||null,search_text:byId("reportSearch")?.value.trim()||"",
      archive_filter:byId("reportArchive")?.value||"active",page_number:state.reportPage,page_size:CONFIG.pageSize
    });
    if(token!==state.viewToken||!byId("reportResults"))return;
    root.innerHTML=reportTable(data.rows||[],false,true)+pagination(data.total,data.page,data.page_size,"report");
    $$("[data-report-id]",root).forEach(btn=>btn.onclick=()=>openReportEditor(btn.dataset.reportId));
    $$("[data-report-archive]",root).forEach(btn=>btn.onclick=()=>archiveReportCard(btn.dataset.reportArchive));
    $$("[data-report-restore]",root).forEach(btn=>btn.onclick=()=>restoreReportCard(btn.dataset.reportRestore));
    bindPagination("report",data);
  }
  async function archiveReportCard(id) {
    const ok=await confirmAction("Remove Report Card","The report will be removed from active records while its revision and audit history remain preserved.","Remove",true);if(!ok)return;
    try{await rpc("archive_report_card",{target_report_id:id,reason_text:"Report card removed from active records"});state.workspace=null;toast("Report card removed");await loadReportPage()}
    catch(error){toast("Report card not removed",friendlyError(error),"error",6500)}
  }
  async function restoreReportCard(id) {
    const ok=await confirmAction("Restore Report Card","The report will return to the active report workflow.","Restore");if(!ok)return;
    try{await rpc("restore_report_card",{target_report_id:id,reason_text:"Report card restored to active records"});state.workspace=null;toast("Report card restored");await loadReportPage()}
    catch(error){toast("Report card not restored",friendlyError(error),"error",6500)}
  }

  async function openNewReportPicker() {
    modal("New Report Card","Select a student enrolment and term",`
      <div class="form-grid">
        <label class="field"><span>Class</span><select id="newReportClass">${optionList(state.boot.classes||[],"id","name")}</select></label>
        <label class="field"><span>Term</span><select id="newReportTerm">${optionList(state.boot.terms||[],"id","name",activeTerm()?.id)}</select></label>
      </div>
      <label class="field" style="margin-top:15px"><span>Student</span><select id="newReportStudent"><option value="">Select class first</option></select></label>`,
      `<button class="button ghost" id="newReportCancel" type="button">Cancel</button><button class="button primary" id="newReportOpen" type="button">Open report</button>`,"small");
    byId("newReportCancel").onclick=closeModal;
    byId("newReportClass").onchange=async()=>{
      const classId=byId("newReportClass").value,select=byId("newReportStudent");
      if(!classId){select.innerHTML=`<option value="">Select class first</option>`;return}
      const data=await rpc("search_students",{search_text:"",target_class_id:classId,target_status:"active",page_number:1,page_size:100});
      select.innerHTML=optionList((data.rows||[]).filter(x=>x.enrollment_id),"enrollment_id","last_name","","Select student")
        .replace(/>([^<]+)<\/option>/g,(m,name)=>{
          const row=(data.rows||[]).find(x=>x.last_name===name);return row?`>${esc(fullName(row))} • ${esc(row.admission_no)}</option>`:m;
        });
      select.innerHTML=`<option value="">Select student</option>`+(data.rows||[]).filter(x=>x.enrollment_id).map(row=>
        `<option value="${attr(row.enrollment_id)}">${esc(fullName(row))} • ${esc(row.admission_no)}</option>`).join("");
    };
    byId("newReportOpen").onclick=()=>{
      const enrollment=byId("newReportStudent").value,term=byId("newReportTerm").value;
      if(enrollment&&term){closeModal();openReportEditor(null,enrollment,term)}
    };
  }
  async function openReportEditor(reportId=null,enrollmentId=null,termId=null) {
    setLoading(true);
    try {
      const editor=await rpc("get_report_editor",{target_report_id:reportId,target_enrollment_id:enrollmentId,target_term_id:termId});
      state.reportEditor=editor;
      state.view="reports";renderNav();
      renderReportEditor();
      const key=`report:${editor.report?.id||`${editor.report?.enrollment_id}:${editor.report?.term_id}`}`;
      const local=await draftGet(key).catch(()=>null);
      if(local&&Number(local.version)===Number(editor.report?.version||0)&&editor.can_edit) {
        applyLocalReportDraft(local.payload);
        toast("Draft restored","Unsaved local changes were recovered.","warning");
      }
    } catch(error){toast("Report unavailable",friendlyError(error),"error");await navigate("reports",true)}
    finally{setLoading(false)}
  }
  async function refreshOpenReport() {
    if(!state.reportEditor?.report?.id)return;
    try{
      const latest=await rpc("get_report_editor",{target_report_id:state.reportEditor.report.id,target_enrollment_id:null,target_term_id:null});
      if(state.reportEditor&&Number(latest.report.version)>Number(state.reportEditor.report.version)) {
        state.reportEditor=latest;renderReportEditor();toast("Report refreshed","A newer version was received.","warning");
      }
    }catch(_){}
  }
  function renderReportEditor() {
    const editor=state.reportEditor,report=editor.report||{},student=editor.student||{},subjects=editor.subjects||[];
    const average=subjects.length?subjects.reduce((sum,s)=>sum+Number(s.total_score||0),0)/subjects.length:0;
    const publication=(editor.publications||[]).find(p=>!p.revoked_at);
    const locked=!editor.can_edit;
    const fieldsLocked=!editor.can_edit_fields;
    const canHeadComment=can("approve_reports")&&!['published','withdrawn'].includes(report.status);
    byId("pageTitle").textContent=student.full_name||"Report Card";
    byId("pageSubtitle").textContent=`${student.class_name||""} • ${student.term_name||""} • ${report.report_number||"New report"}`;
    byId("content").innerHTML=`
      <div class="page-head"><div><h3>${esc(student.full_name)}</h3><p>${esc(student.admission_no)} • ${esc(student.class_name)} • ${esc(student.academic_year_name)} • ${esc(student.term_name)}</p></div>
        <div class="page-actions"><button class="button ghost" id="reportBack">Back to reports</button>
          ${report.id?`<button class="button outline" id="reportHistory">Revisions</button>`:""}
          ${publication?.storage_path?`<button class="button outline" id="reportDownload">Download PDF</button>`:""}
          ${report.id&&canRemoveReportRow(report)?`<button class="button danger" id="reportRemove">Remove</button>`:""}
        </div></div>
      <div class="report-layout">
        <section class="panel">
          <div class="panel-header"><div><h3>Assessment Record</h3><p>${statusBadge(report.status)}</p></div>
            <div class="button-row">${locked?`<span class="chip">Read only</span>`:`<span class="chip">Version ${number(report.version||0)}</span>`}</div></div>
          <div class="panel-body">
            <form id="reportForm" class="form-stack">
              <div class="form-grid three">
                <label class="field"><span>Days school opened</span><input name="days_school_opened" type="number" min="0" value="${attr(report.days_school_opened||0)}" ${fieldsLocked?"disabled":""}></label>
                <label class="field"><span>Days present</span><input name="days_present" type="number" min="0" value="${attr(report.days_present||0)}" ${fieldsLocked?"disabled":""}></label>
                <label class="field"><span>Promoted to</span><select name="promoted_to_class_id" ${fieldsLocked?"disabled":""}>${optionList(state.boot.classes||[],"id","name",report.promoted_to_class_id,"Not specified")}</select></label>
                <label class="field"><span>Attitude</span><input name="attitude" value="${attr(report.attitude||"")}" ${fieldsLocked?"disabled":""}></label>
                <label class="field"><span>Conduct</span><input name="conduct" value="${attr(report.conduct||"")}" ${fieldsLocked?"disabled":""}></label>
                <label class="field"><span>Interest or talent</span><input name="interest" value="${attr(report.interest||"")}" ${fieldsLocked?"disabled":""}></label>
                <div class="full comment-actions">${editor.can_edit_fields||canHeadComment?`<button class="button secondary small" id="reportGenerateComments" type="button">Generate comments</button>`:""}
                  ${locked&&canHeadComment?`<button class="button primary small" id="reportSaveComments" type="button">Save comments</button>`:""}</div>
                <label class="field full"><span>Class teacher's comment</span><textarea name="teacher_comment" ${fieldsLocked?"disabled":""}>${esc(report.teacher_comment||"")}</textarea></label>
                <label class="field full"><span>Principal's comment</span><textarea name="head_comment" ${canHeadComment?"":"disabled"}>${esc(report.head_comment||"")}</textarea></label>
              </div>
              <div class="section-title"><h4>Subject Results</h4><span class="chip">${subjects.length} subjects</span></div>
              <div class="score-grid"><table><thead><tr><th>Subject</th><th>Assessment Components</th><th>Total</th><th>Grade</th><th>Remark</th><th>Initials</th></tr></thead>
                <tbody>${subjects.map((subject,index)=>reportSubjectRow(subject,index,!subject.can_score)).join("")}</tbody></table></div>
            </form>
          </div>
        </section>
        <aside class="report-sidebar">
          <div class="report-summary"><p>Current average</p><div class="summary-number" id="reportAverage">${number(average,1)}%</div>
            <p>${esc(report.report_number||"Unpublished record")}</p></div>
          <section class="panel pad"><div class="section-title"><h4>Workflow</h4></div>
            <div class="workflow">${workflowButtons(report,publication)}</div></section>
          <section class="panel pad"><div class="section-title"><h4>Activity</h4></div>
            <div class="timeline">${(editor.workflow||[]).length?(editor.workflow||[]).slice(0,8).map(item=>`
              <div class="timeline-item"><span class="timeline-dot"></span><div class="timeline-copy"><strong>${esc(item.to_status.replaceAll("_"," "))}</strong>
              <small>${isoDateTime(item.created_at)}${item.comment?` • ${esc(item.comment)}`:""}</small></div></div>`).join(""):`<p class="help-text">No workflow activity</p>`}</div></section>
        </aside>
      </div>`;
    byId("reportBack").onclick=()=>navigate("reports",true);
    byId("reportHistory")?.addEventListener("click",openRevisionHistory);
    byId("reportDownload")?.addEventListener("click",()=>downloadOfficialPdf(publication));
    byId("reportRemove")?.addEventListener("click",async()=>{const id=report.id;await archiveReportCard(id);if(state.view==="reports")await navigate("reports",true)});
    byId("reportSave")?.addEventListener("click",saveOpenReport);
    byId("reportGenerateComments")?.addEventListener("click",()=>applyAutomaticComments(true));
    byId("reportSaveComments")?.addEventListener("click",saveLockedReportComments);
    $$("[data-transition]").forEach(button=>button.onclick=()=>requestTransition(button.dataset.transition));
    byId("reportGeneratePdf")?.addEventListener("click",()=>generateAndUploadOfficialPdf());
    byId("reportCorrection")?.addEventListener("click",openCorrection);
    $$("[data-component-input]").forEach(input=>input.addEventListener("input",()=>{
      recalculateSubject(Number(input.dataset.subjectIndex));
      scheduleLocalDraft();
    }));
    $$("[data-teacher-initials]").forEach(input=>input.addEventListener("input",scheduleLocalDraft));
    $$("#reportForm input,#reportForm textarea,#reportForm select").forEach(input=>input.addEventListener("change",scheduleLocalDraft));
    setTimeout(()=>applyAutomaticComments(false),0);
  }
  function reportSubjectRow(subject,index,locked) {
    return `<tr data-subject-row="${index}">
      <td><div class="cell-copy"><strong>${esc(subject.subject_name)}</strong><small>${esc(subject.subject_code)} • ${esc(subject.scheme_name||"")}</small></div></td>
      <td><div class="chip-list">${(subject.components||[]).map(component=>`<label class="chip">
        <span>${esc(component.code)} / ${number(component.maximum_score,0)}</span>
        <input class="score-input" data-component-input data-subject-index="${index}" data-component-id="${attr(component.component_id)}"
          data-max="${attr(component.maximum_score)}" data-weight="${attr(component.weight)}" type="number" min="0" max="${attr(component.maximum_score)}"
          step=".01" value="${attr(component.raw_score||0)}" ${locked?"disabled":""}>
      </label>`).join("")}</div></td>
      <td class="score-total" data-subject-total="${index}">${number(subject.total_score,1)}</td>
      <td data-subject-grade="${index}">${esc(subject.grade||"—")}</td><td>${esc(subject.remark||"")}</td>
      <td><input class="score-input" data-teacher-initials="${index}" value="${attr(subject.teacher_initials||"")}" ${locked?"disabled":""}></td>
    </tr>`;
  }
  function recalculateSubject(index) {
    const subject=state.reportEditor.subjects[index];
    let total=0;
    $$(`[data-subject-index="${index}"]`).forEach(input=>{
      const raw=Math.max(0,Math.min(Number(input.value||0),Number(input.dataset.max||0)));
      total+=(raw/Number(input.dataset.max||1))*Number(input.dataset.weight||0);
    });
    subject.total_score=Math.round(total*100)/100;
    $(`[data-subject-total="${index}"]`).textContent=number(subject.total_score,1);
    const totals=state.reportEditor.subjects.map(s=>Number(s.total_score||0));
    byId("reportAverage").textContent=`${number(totals.reduce((a,b)=>a+b,0)/(totals.length||1),1)}%`;
    if(byId("reportForm")?.elements.teacher_comment?.dataset.autoGenerated==="true"||byId("reportForm")?.elements.head_comment?.dataset.autoGenerated==="true")applyAutomaticComments(false);
  }
  function automaticCommentText() {
    const editor=state.reportEditor,student=editor?.student||{},subjects=editor?.subjects||[];
    const scores=subjects.map(subject=>({name:subject.subject_name||"the assessed subjects",score:Number(subject.total_score||0)}));
    const average=scores.length?scores.reduce((sum,item)=>sum+item.score,0)/scores.length:0;
    const strongest=[...scores].sort((a,b)=>b.score-a.score)[0]?.name||"the assessed subjects";
    const weakest=[...scores].sort((a,b)=>a.score-b.score)[0]?.name||"the weaker subjects";
    const firstName=student.first_name||student.full_name?.split(" ")[0]||"The student";
    const pronoun=student.gender==="Male"?"He":student.gender==="Female"?"She":"They";
    const form=byId("reportForm"),opened=Number(form?.elements.days_school_opened?.value||0),present=Number(form?.elements.days_present?.value||0);
    const attendance=opened>0?present/opened*100:0;
    const mark=number(average,1);
    let teacherComment,headComment;
    if(!scores.length){teacherComment=`${firstName}'s assessment record is incomplete and requires all subject results.`;headComment="Complete the outstanding assessment records before final approval."}
    else if(average>=85){teacherComment=`${firstName} has demonstrated outstanding academic performance with an average of ${mark}%. ${pronoun} showed exceptional strength in ${strongest}. Maintain this excellent standard.`;headComment="Excellent performance. Continue to pursue excellence and remain a positive example to others."}
    else if(average>=75){teacherComment=`${firstName} has achieved a very good academic performance with an average of ${mark}%. ${pronoun} performed especially well in ${strongest} and should continue working consistently.`;headComment="Very good performance. Keep working diligently and aim for an even higher standard next term."}
    else if(average>=65){teacherComment=`${firstName} has made good academic progress with an average of ${mark}%. ${pronoun} showed strength in ${strongest} and should give additional attention to ${weakest}.`;headComment="Good progress. Maintain steady effort and improve the areas that require greater attention."}
    else if(average>=50){teacherComment=`${firstName} has produced a satisfactory performance with an average of ${mark}%. More regular revision, active class participation, and focused practice in ${weakest} will improve future results.`;headComment="Satisfactory performance. Greater consistency and focused study are required for stronger achievement."}
    else if(average>=40){teacherComment=`${firstName} has shown a fair performance with an average of ${mark}%. ${pronoun} needs sustained support, regular practice, and closer attention to ${weakest}.`;headComment="There is potential for improvement. Work closely with teachers and maintain a disciplined study routine."}
    else {teacherComment=`${firstName} needs substantial academic improvement. The current average is ${mark}%, and immediate support is required, particularly in ${weakest}.`;headComment="Considerable improvement is required. Consistent effort, supervision, and remedial support should begin immediately."}
    if(opened>0&&attendance<85)teacherComment+=` Attendance also requires improvement (${present} of ${opened} days present).`;
    else if(opened>0&&attendance>=95)teacherComment+=` ${pronoun} maintained excellent attendance.`;
    const promoted=form?.elements.promoted_to_class_id?.selectedOptions?.[0]?.textContent||"";
    if(promoted&&form.elements.promoted_to_class_id.value)headComment+=` Promotion: ${promoted}.`;
    return {teacherComment,headComment,average};
  }
  function applyAutomaticComments(force=false) {
    if(!state.reportEditor||!byId("reportForm"))return;
    const generated=automaticCommentText(),form=byId("reportForm");
    const teacher=form.elements.teacher_comment,head=form.elements.head_comment;
    if(teacher&&!teacher.disabled&&(force||!teacher.value.trim()||teacher.dataset.autoGenerated==="true")){
      teacher.value=generated.teacherComment;teacher.dataset.autoGenerated="true";
    }
    if(head&&!head.disabled&&(force||!head.value.trim()||head.dataset.autoGenerated==="true")){
      head.value=generated.headComment;head.dataset.autoGenerated="true";
    }
    state.autoComments=generated;scheduleLocalDraft();
  }
  async function saveLockedReportComments() {
    const report=state.reportEditor?.report,form=byId("reportForm"),button=byId("reportSaveComments");
    if(!report?.id||!form)return;if(button)button.disabled=true;
    try{
      state.reportEditor=await rpc("save_report_comments",{
        target_report_id:report.id,teacher_comment_text:null,
        head_comment_text:form.elements.head_comment?.value||"",expected_version:report.version
      });
      state.workspace=null;renderReportEditor();toast("Comments saved");
    }catch(error){if(error?.code==="40001")await refreshOpenReport();toast("Comments not saved",friendlyError(error),"error")}
    finally{if(button)button.disabled=false}
  }

  function workflowButtons(report,publication) {
    const buttons=[],allowed=new Set(state.reportEditor.allowed_transitions||[]);
    if(state.reportEditor.can_edit)buttons.push(`<button class="button primary full" id="reportSave">Save report</button>`);
    if(allowed.has("submitted"))buttons.push(`<button class="button secondary full" data-transition="submitted">Submit for Principal approval</button>`);
    if(allowed.has("class_reviewed"))buttons.push(`<button class="button success full" data-transition="class_reviewed">Complete class review</button>`);
    if(allowed.has("approved"))buttons.push(`<button class="button success full" data-transition="approved">Approve report</button>`);
    if(allowed.has("published"))buttons.push(`<button class="button success full" data-transition="published">Publish report</button>`);
    if(allowed.has("returned"))buttons.push(`<button class="button warning full" data-transition="returned">Return for correction</button>`);
    if(report.status==="published"&&!publication?.storage_path&&can("publish_reports"))buttons.push(`<button class="button primary full" id="reportGeneratePdf">Create official PDF</button>`);
    if(["published","approved"].includes(report.status)&&can("approve_reports"))buttons.push(`<button class="button warning full" id="reportCorrection">Open correction</button>`);
    if(allowed.has("withdrawn"))buttons.push(`<button class="button danger full" data-transition="withdrawn">Withdraw publication</button>`);
    return buttons.join("")||`<span class="help-text">No workflow action available</span>`;
  }
  function collectReportPayload() {
    const form=byId("reportForm"),values=formObject(form),editor=state.reportEditor;
    const subjects=editor.subjects.map((subject,index)=>({subject,index})).filter(item=>item.subject.can_score).map(({subject,index})=>({
      subject_id:subject.subject_id,scheme_id:subject.scheme_id,
      teacher_initials:$(`[data-teacher-initials="${index}"]`)?.value.trim()||"",
      components:(subject.components||[]).map(component=>({component_id:component.component_id,raw_score:Number($(`[data-subject-index="${index}"][data-component-id="${component.component_id}"]`)?.value||0)}))
    }));
    const fields=editor.can_edit_fields?{days_school_opened:Number(values.days_school_opened||0),days_present:Number(values.days_present||0),
      attitude:values.attitude||"",conduct:values.conduct||"",interest:values.interest||"",
      teacher_comment:values.teacher_comment||"",head_comment:values.head_comment??editor.report.head_comment??"",
      promoted_to_class_id:values.promoted_to_class_id||null}:{};
    return {report_id:editor.report.id||null,enrollment_id:editor.report.enrollment_id,term_id:editor.report.term_id,fields,subjects,reason:"Report assessment updated"};
  }
  function scheduleLocalDraft() {
    clearTimeout(scheduleLocalDraft.timer);
    scheduleLocalDraft.timer=setTimeout(async()=>{
      if(!state.reportEditor?.can_edit||!byId("reportForm"))return;
      const payload=collectReportPayload(),key=`report:${state.reportEditor.report.id||`${payload.enrollment_id}:${payload.term_id}`}`;
      await draftPut({key,payload,version:state.reportEditor.report.version||0,savedAt:new Date().toISOString()}).catch(()=>{});
    },450);
  }
  function applyLocalReportDraft(payload) {
    if(!payload||!byId("reportForm"))return;
    const f=payload.fields||{},form=byId("reportForm");
    Object.entries(f).forEach(([key,value])=>{if(form.elements[key]&&!form.elements[key].disabled)form.elements[key].value=value??""});
    (payload.subjects||[]).forEach(subject=>{
      const index=(state.reportEditor.subjects||[]).findIndex(item=>item.subject_id===subject.subject_id);if(index<0||!state.reportEditor.subjects[index].can_score)return;
      (subject.components||[]).forEach(component=>{const input=$(`[data-subject-index="${index}"][data-component-id="${component.component_id}"]`);if(input&&!input.disabled)input.value=component.raw_score});
      const initials=$(`[data-teacher-initials="${index}"]`);if(initials&&!initials.disabled)initials.value=subject.teacher_initials||"";recalculateSubject(index);
    });
  }
  async function saveOpenReport() {
    const form=byId("reportForm");if(form&&!form.reportValidity())return;
    const button=byId("reportSave");if(button)button.disabled=true;
    const payload=collectReportPayload(),expected=state.reportEditor.report.version||null;let persisted=false;
    try {
      let saved;
      if(!state.online) saved=await queueReportSave(payload,expected);
      else {
        try{saved=await rpc("save_report_card",{payload,expected_version:expected});persisted=true}
        catch(error){
          if(error?.message?.toLowerCase().includes("fetch")||error?.name==="TypeError"){saved=await queueReportSave(payload,expected)}
          else throw error;
        }
      }
      if(saved?.report){state.workspace=null;state.reportEditor=saved;renderReportEditor()}
      const key=`report:${payload.report_id||`${payload.enrollment_id}:${payload.term_id}`}`;await draftDelete(key).catch(()=>{});
      if(persisted)toast("Report saved");
    } catch(error){
      if(persisted){await reportClientError(error,{source:"report_save",stage:"refresh"});toast("Report saved","Reload the page to display the latest report.","warning",6500);return}
      if(error?.code==="40001"||String(error?.message).includes("changed by another user"))await refreshOpenReport();
      toast("Report not saved",friendlyError(error),"error");
    } finally{if(button)button.disabled=false}
  }
  async function requestTransition(targetStatus) {
    const labels={submitted:"Submit report",class_reviewed:"Complete review",approved:"Approve report",published:"Publish report",returned:"Return report",withdrawn:"Withdraw publication"};
    modal(labels[targetStatus]||"Update report status","",`<label class="field"><span>Comment</span><textarea id="workflowComment"></textarea></label>`,
      `<button class="button ghost" id="workflowCancel" type="button">Cancel</button><button class="button ${targetStatus==="withdrawn"?"danger":"primary"}" id="workflowConfirm" type="button">${esc(labels[targetStatus]||"Continue")}</button>`,"small");
    byId("workflowCancel").onclick=closeModal;
    byId("workflowConfirm").onclick=async()=>{
      const comment=byId("workflowComment").value.trim(),button=byId("workflowConfirm");button.disabled=true;
      try{
        if(state.reportEditor.can_edit&&["submitted"].includes(targetStatus))await saveOpenReport();
        const updated=await rpc("transition_report_status",{target_report_id:state.reportEditor.report.id,target_status:targetStatus,
          comment_text:comment,expected_version:state.reportEditor.report.version});
        state.workspace=null;state.reportEditor=updated;closeModal();toast("Report status updated");
        renderReportEditor();
        if(targetStatus==="published")await generateAndUploadOfficialPdf();
      }catch(error){toast("Workflow action unsuccessful",friendlyError(error),"error");if(error?.code==="40001")await refreshOpenReport()}
      finally{button.disabled=false}
    };
  }
  async function openCorrection() {
    modal("Open Report Correction","Published records remain preserved in revision history",`<label class="field"><span>Correction reason</span><textarea id="correctionReason" required></textarea></label>`,
      `<button class="button ghost" id="correctionCancel" type="button">Cancel</button><button class="button warning" id="correctionOpen" type="button">Open correction</button>`,"small");
    byId("correctionCancel").onclick=closeModal;
    byId("correctionOpen").onclick=async()=>{
      const reason=byId("correctionReason").value.trim();if(!reason)return;
      try{state.reportEditor=await rpc("begin_report_correction",{target_report_id:state.reportEditor.report.id,reason_text:reason});closeModal();renderReportEditor();toast("Correction opened")}
      catch(error){toast("Correction not opened",friendlyError(error),"error")}
    };
  }
  async function openRevisionHistory() {
    const revisions=await rpc("get_report_revisions",{target_report_id:state.reportEditor.report.id});
    modal("Report Revisions",state.reportEditor.report.report_number||"",`
      <div class="form-grid">
        <label class="field"><span>Earlier revision</span><select id="revisionA">${(revisions||[]).map((r,i)=>`<option value="${i}" ${i===Math.min(1,revisions.length-1)?"selected":""}>Version ${r.version} • ${isoDateTime(r.created_at)}</option>`).join("")}</select></label>
        <label class="field"><span>Later revision</span><select id="revisionB">${(revisions||[]).map((r,i)=>`<option value="${i}" ${i===0?"selected":""}>Version ${r.version} • ${isoDateTime(r.created_at)}</option>`).join("")}</select></label>
      </div>
      <div id="revisionDiff" style="margin-top:18px"></div>`,
      `<button class="button ghost" id="revisionClose" type="button">Close</button>`,"wide");
    const render=()=>renderRevisionDiff(revisions[Number(byId("revisionA").value)],revisions[Number(byId("revisionB").value)]);
    byId("revisionA").onchange=render;byId("revisionB").onchange=render;byId("revisionClose").onclick=closeModal;render();
  }
  function renderRevisionDiff(a,b) {
    const root=byId("revisionDiff");if(!root||!a||!b)return;
    const fields=["status","days_school_opened","days_present","attitude","conduct","interest","teacher_comment","head_comment","promoted_to_class_id"];
    const ar=a.snapshot?.report||{},br=b.snapshot?.report||{};
    const scoreMap=snapshot=>Object.fromEntries((snapshot?.results||[]).map(x=>[x.subject_name,x.total_score]));
    const as=scoreMap(a.snapshot),bs=scoreMap(b.snapshot),subjects=[...new Set([...Object.keys(as),...Object.keys(bs)])];
    root.innerHTML=`<div class="revision-compare">
      <div class="diff-card"><h4>Version ${a.version}</h4>${fields.map(key=>`<div class="diff-row ${String(ar[key]??"")!==String(br[key]??"")?"changed":""}"><span>${esc(key.replaceAll("_"," "))}</span><b>${esc(ar[key]??"—")}</b></div>`).join("")}</div>
      <div class="diff-card"><h4>Version ${b.version}</h4>${fields.map(key=>`<div class="diff-row ${String(ar[key]??"")!==String(br[key]??"")?"changed":""}"><span>${esc(key.replaceAll("_"," "))}</span><b>${esc(br[key]??"—")}</b></div>`).join("")}</div>
    </div>
    <div class="section-title" style="margin-top:18px"><h4>Score changes</h4></div>
    <div class="table-wrap"><table><thead><tr><th>Subject</th><th>Version ${a.version}</th><th>Version ${b.version}</th><th>Change</th></tr></thead><tbody>
      ${subjects.map(name=>`<tr><td>${esc(name)}</td><td>${number(as[name],1)}</td><td>${number(bs[name],1)}</td><td>${number(Number(bs[name]||0)-Number(as[name]||0),1)}</td></tr>`).join("")}
    </tbody></table></div>`;
  }
  function openScoreImport() {
    modal("Import Scores","CSV assessment score entries",`<form id="scoreImportForm" class="form-stack">
      <div class="form-grid"><label class="field"><span>Term</span><select name="term_id" required>${optionList(state.boot.terms||[],"id","name",activeTerm()?.id)}</select></label>
      <label class="field"><span>Class</span><select name="class_id" required>${optionList(state.boot.classes||[],"id","name")}</select></label></div>
      <label class="file-drop"><strong>CSV file</strong><input name="file" type="file" accept=".csv,text/csv" required></label>
    </form>`,`<button class="button ghost" id="scoreImportCancel" type="button">Cancel</button><button class="button primary" id="scoreImportRun" type="button">Import</button>`,"small");
    byId("scoreImportCancel").onclick=closeModal;
    byId("scoreImportRun").onclick=async()=>{
      const form=byId("scoreImportForm"),v=formObject(form),file=form.elements.file.files[0];if(!file)return;
      const rows=parseCsv(await file.text()),button=byId("scoreImportRun");button.disabled=true;
      try{const result=await rpc("bulk_import_scores",{target_term_id:v.term_id,target_class_id:v.class_id,rows,filename:file.name});
        closeModal();toast("Score import completed",`${result.successful} saved, ${result.failed} failed`,result.failed?"warning":"success",7000);await loadReportPage()}
      catch(error){toast("Score import unsuccessful",friendlyError(error),"error")}finally{button.disabled=false}
    };
  }
  async function exportReportList() {
    const data=await rpc("list_report_cards_v6",{target_term_id:byId("reportTerm")?.value||null,target_class_id:byId("reportClass")?.value||null,
      target_status:byId("reportStatus")?.value||null,search_text:byId("reportSearch")?.value||"",archive_filter:byId("reportArchive")?.value||"active",page_number:1,page_size:100});
    const headers=["report_number","student_name","admission_no","class_name","academic_year_name","term_name","average","status","updated_at"];
    downloadText("report-cards.csv",[headers.join(","),...(data.rows||[]).map(row=>headers.map(h=>csvCell(row[h])).join(","))].join("\n"),"text/csv");
  }

  async function generateAndUploadOfficialPdf() {
    const editor=state.reportEditor,publication=(editor.publications||[]).find(p=>!p.revoked_at);
    if(!publication)throw new Error("Publication record not found");
    setLoading(true);
    try{
      const pdf=await createReportPdf(editor,publication);
      const checksum=await sha256(pdf),safeName=(editor.report.report_number||editor.report.id).replace(/[^A-Za-z0-9_-]/g,"_");
      const path=`${editor.report.id}/${safeName}-v${editor.report.version}.pdf`;
      const {error}=await state.client.storage.from(CONFIG.pdfBucket).upload(path,pdf,{contentType:"application/pdf",upsert:true,cacheControl:"31536000"});
      if(error)throw error;
      await rpc("register_report_pdf",{target_report_id:editor.report.id,target_storage_path:path,target_checksum:checksum,target_page_count:1});
      state.reportEditor=await rpc("get_report_editor",{target_report_id:editor.report.id,target_enrollment_id:null,target_term_id:null});
      renderReportEditor();downloadBlob(`${safeName}.pdf`,pdf);toast("Official PDF created");
    }catch(error){toast("PDF not created",friendlyError(error),"error");await reportClientError(error,{source:"pdf",report_id:editor.report.id})}
    finally{setLoading(false)}
  }
  async function downloadOfficialPdf(publication) {
    try{
      const url=await signedUrl(CONFIG.pdfBucket,publication.storage_path,120);
      const a=document.createElement("a");a.href=url;a.target="_blank";a.rel="noopener";a.click();
    }catch(error){toast("PDF unavailable",friendlyError(error),"error")}
  }
  function downloadBlob(filename,blob) {
    const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);
  }
  async function sha256(blob) {
    const bytes=await blob.arrayBuffer(),hash=await crypto.subtle.digest("SHA-256",bytes);
    return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,"0")).join("");
  }
  async function loadImage(url) {
    return new Promise((resolve,reject)=>{const image=new Image();image.crossOrigin="anonymous";image.onload=()=>resolve(image);image.onerror=reject;image.src=url});
  }
  function drawImageContain(ctx,image,x,y,width,height) {
    const scale=Math.min(width/image.width,height/image.height),drawWidth=image.width*scale,drawHeight=image.height*scale;ctx.drawImage(image,x+(width-drawWidth)/2,y+(height-drawHeight)/2,drawWidth,drawHeight);
  }
  function drawWrapped(ctx,text,x,y,maxWidth,lineHeight,maxLines=3) {
    const words=String(text||"").split(/\s+/);let line="",lines=0;
    for(const word of words){
      const test=line?`${line} ${word}`:word;
      if(ctx.measureText(test).width>maxWidth&&line){ctx.fillText(line,x,y);y+=lineHeight;lines++;line=word;if(lines>=maxLines)return y}
      else line=test;
    }
    if(line&&lines<maxLines){ctx.fillText(line,x,y);y+=lineHeight}
    return y;
  }
  async function qrCanvas(text) {
    const box=byId("qrScratch");box.innerHTML="";
    if(!window.QRCode)return null;
    new window.QRCode(box,{text,width:190,height:190,correctLevel:window.QRCode.CorrectLevel.M});
    await sleep(80);
    const canvas=box.querySelector("canvas");if(canvas)return canvas;
    const img=box.querySelector("img");if(img)return img;
    return null;
  }
  async function createReportPdf(editor,publication) {
    const canvas=document.createElement("canvas");canvas.width=1240;canvas.height=1754;
    const ctx=canvas.getContext("2d"),school=state.boot.school||{},student=editor.student||{},report=editor.report||{},subjects=editor.subjects||[];
    const signer=report.id?await rpc("get_report_headteacher_signature",{target_report_id:report.id}).catch(()=>({})):{};
    let signatureImage=null;if(signer.signature_path){try{signatureImage=await loadImage(await signedUrl(CONFIG.signatureBucket,signer.signature_path,600))}catch(_){signatureImage=null}}
    ctx.fillStyle="#fff";ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle=school.primary_colour||"#082d70";ctx.fillRect(0,0,canvas.width,205);
    const logo=await loadImage(school.logo_url?.startsWith("http")?school.logo_url:CONFIG.logoPath).catch(()=>null);
    if(logo){ctx.save();ctx.globalAlpha=.055;drawImageContain(ctx,logo,300,500,640,640);ctx.restore();ctx.drawImage(logo,55,28,145,145)};
    ctx.fillStyle="#fff";ctx.font="bold 46px Arial";ctx.fillText(school.school_name||"Nipe International School",225,75);
    ctx.font="24px Arial";ctx.fillText(school.motto||"",225,116);
    ctx.font="bold 30px Arial";ctx.fillText(school.report_title||"Student Terminal Report",225,165);
    ctx.fillStyle="#15233b";ctx.font="bold 23px Arial";
    ctx.fillText(`Name: ${student.full_name||""}`,60,255);ctx.fillText(`Admission No.: ${student.admission_no||""}`,710,255);
    ctx.font="20px Arial";ctx.fillText(`Class: ${student.class_name||""}`,60,298);ctx.fillText(`Academic Year: ${student.academic_year_name||""}`,440,298);ctx.fillText(`Term: ${student.term_name||""}`,880,298);
    ctx.strokeStyle="#b7c4d6";ctx.lineWidth=1;ctx.strokeRect(55,330,1130,800);
    const cols=[55,370,765,875,960,1185],headerY=330,rowH=Math.min(46,720/Math.max(subjects.length,1));
    ctx.fillStyle="#e9f1fc";ctx.fillRect(55,330,1130,52);ctx.fillStyle="#102850";ctx.font="bold 18px Arial";
    ["Subject","Assessment","Total","Grade","Remark"].forEach((label,i)=>ctx.fillText(label,cols[i]+10,363));
    ctx.strokeStyle="#cbd5e2";cols.forEach(x=>{ctx.beginPath();ctx.moveTo(x,330);ctx.lineTo(x,1130);ctx.stroke()});
    let y=382;ctx.font="17px Arial";
    for(const subject of subjects){
      ctx.strokeStyle="#dce3ec";ctx.beginPath();ctx.moveTo(55,y+rowH);ctx.lineTo(1185,y+rowH);ctx.stroke();
      ctx.fillStyle="#172238";ctx.fillText(subject.subject_name,65,y+rowH*.65);
      const componentText=(subject.components||[]).map(c=>`${c.code}: ${number(c.raw_score,1)}`).join("  ");
      ctx.font="15px Arial";ctx.fillText(componentText,380,y+rowH*.65);ctx.font="17px Arial";
      ctx.fillText(number(subject.total_score,1),785,y+rowH*.65);ctx.fillText(subject.grade||"",900,y+rowH*.65);
      ctx.font="14px Arial";drawWrapped(ctx,subject.remark||"",970,y+rowH*.48,200,15,2);ctx.font="17px Arial";y+=rowH;
    }
    const avg=subjects.length?subjects.reduce((s,x)=>s+Number(x.total_score||0),0)/subjects.length:0;
    const position=report.id?await rpc("report_position",{target_report_id:report.id}).catch(()=>({position:0,class_size:0})):{position:0,class_size:0};
    ctx.fillStyle="#f4f7fb";ctx.fillRect(55,1155,1130,160);ctx.fillStyle="#172238";ctx.font="bold 22px Arial";
    ctx.fillText(`Average: ${number(avg,1)}%`,75,1198);ctx.fillText(`Attendance: ${report.days_present||0} / ${report.days_school_opened||0}`,430,1198);
    ctx.fillText(position.position?`Position: ${position.position} / ${position.class_size}`:`Status: ${String(report.status||"").toUpperCase()}`,850,1198);
    ctx.font="18px Arial";ctx.fillText(`Attitude: ${report.attitude||"—"}`,75,1242);ctx.fillText(`Conduct: ${report.conduct||"—"}`,430,1242);ctx.fillText(`Interest: ${report.interest||"—"}`,850,1242);
    ctx.font="bold 17px Arial";ctx.fillText("Class Teacher's Comment",60,1360);ctx.font="17px Arial";drawWrapped(ctx,report.teacher_comment||"",60,1390,760,25,3);
    ctx.font="bold 17px Arial";ctx.fillText("Principal's Comment",60,1485);ctx.font="17px Arial";drawWrapped(ctx,report.head_comment||"",60,1515,520,25,3);
    if(signatureImage)drawImageContain(ctx,signatureImage,610,1480,260,105);
    ctx.strokeStyle="#45556f";ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(610,1595);ctx.lineTo(875,1595);ctx.stroke();ctx.fillStyle="#172238";ctx.font="bold 15px Arial";ctx.fillText(signer.full_name||school.head_name||"Principal",610,1620);ctx.font="13px Arial";ctx.fillStyle="#5a687d";ctx.fillText(signatureImage?"Digitally signed by the Principal":"Principal",610,1642);
    const base=school.verification_base_url||`${location.origin}${location.pathname}`;
    const verifyUrl=`${base}${base.includes("?")?"&":"?"}verify=${publication.verification_token}`;
    const qr=await qrCanvas(verifyUrl);
    if(qr)ctx.drawImage(qr,920,1365,210,210);
    ctx.fillStyle="#3f4e66";ctx.font="14px Arial";ctx.fillText(`Report No.: ${report.report_number||""}`,60,1668);
    ctx.fillText(`Published: ${isoDateTime(publication.published_at)}`,60,1695);
    ctx.fillText(`Verification: ${String(publication.verification_token).slice(0,18)}…`,920,1608);
    ctx.strokeStyle=school.primary_colour||"#082d70";ctx.lineWidth=7;ctx.beginPath();ctx.moveTo(0,1738);ctx.lineTo(1240,1738);ctx.stroke();
    const jpeg=await new Promise(resolve=>canvas.toBlob(resolve,"image/jpeg",.92));
    return imagePdf(jpeg,595.28,841.89);
  }
  async function imagePdf(jpegBlob,pageWidth,pageHeight) {
    const jpeg=new Uint8Array(await jpegBlob.arrayBuffer()),parts=[],offsets=[0];let length=0;
    const add=value=>{const bytes=typeof value==="string"?new TextEncoder().encode(value):value;parts.push(bytes);length+=bytes.length};
    add("%PDF-1.4\n%\xFF\xFF\xFF\xFF\n");
    const object=(id,body)=>{offsets[id]=length;add(`${id} 0 obj\n${body}\nendobj\n`)};
    object(1,"<< /Type /Catalog /Pages 2 0 R >>");
    object(2,"<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    object(3,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
    offsets[4]=length;add(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width 1240 /Height 1754 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);add(jpeg);add("\nendstream\nendobj\n");
    const content=`q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ`;
    object(5,`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const xref=length;add("xref\n0 6\n0000000000 65535 f \n");
    for(let i=1;i<=5;i++)add(`${String(offsets[i]).padStart(10,"0")} 00000 n \n`);
    add(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
    return new Blob(parts,{type:"application/pdf"});
  }


  async function renderChildren(token) {
    const data=await rpc("list_my_children_reports");
    if(token!==state.viewToken)return;
    const children=data.children||[];
    byId("content").innerHTML=`
      <div class="page-head"><div><h3>My Children</h3><p>Published report cards available for viewing and PDF download</p></div></div>
      <div class="grid ${children.length>1?"two":""}" id="childrenGrid">
        ${children.length?children.map(child=>`<section class="panel">
          <div class="panel-header"><div class="cell-copy"><strong>${esc(child.full_name)}</strong><small>${esc(child.admission_no)} • ${esc(child.class_name||"")}</small></div></div>
          <div class="panel-body">${(child.reports||[]).length?(child.reports||[]).map(report=>`<div class="diff-row"><span><strong>${esc(report.term_name)}</strong><br><small>${esc(report.academic_year_name)} • ${number(report.average,1)}%</small></span>
            <div class="button-row"><button class="button outline small" data-child-report="${attr(report.id)}">View report</button>${report.publication?.storage_path?`<button class="button secondary small" data-child-pdf="${attr(report.id)}">Download PDF</button>`:""}</div></div>`).join(""):`<div class="empty"><strong>No published reports</strong></div>`}</div>
        </section>`).join(""):`<section class="panel pad empty"><strong>No linked student report records</strong><span>Ask the System Administrator to verify the parent-student link.</span></section>`}
      </div>`;
    $$('[data-child-report]').forEach(button=>button.onclick=()=>openReportEditor(button.dataset.childReport));
    $$('[data-child-pdf]').forEach(button=>button.onclick=()=>{
      const report=children.flatMap(child=>child.reports||[]).find(item=>item.id===button.dataset.childPdf);
      if(report?.publication?.storage_path)downloadOfficialPdf(report.publication);
    });
  }

  async function renderTeachers(token) {
    byId("content").innerHTML=`
      <div class="page-head"><div><h3>Teacher Directory</h3><p>Staff records, accounts, classes, and subjects</p></div>
        <div class="page-actions"><button class="button outline" id="teacherExport">Export CSV</button><button class="button primary" id="teacherAdd">Add teacher</button></div></div>
      <section class="panel">
        <div class="toolbar">
          <label class="search"><input id="teacherSearch" type="search" placeholder="Search teacher or staff number"></label>
          <select id="teacherStatus"><option value="">All statuses</option><option value="active">Active</option><option value="leave">On leave</option><option value="suspended">Suspended</option><option value="resigned">Resigned</option><option value="retired">Retired</option></select>
          <select id="teacherArchive"><option value="active">Current records</option><option value="archived">Archived records</option><option value="all">All records</option></select>
        </div>
        <div id="teacherResults"><div class="empty">Loading teachers</div></div>
      </section>`;
    byId("teacherAdd").onclick=()=>openTeacherEditor();
    byId("teacherExport").onclick=exportTeachersCsv;
    let timer;
    byId("teacherSearch").oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>{state.teacherPage=1;loadTeacherPage(token)},250)};
    byId("teacherStatus").onchange=()=>{state.teacherPage=1;loadTeacherPage(token)};
    byId("teacherArchive").onchange=()=>{state.teacherPage=1;loadTeacherPage(token)};
    await loadTeacherPage(token);
  }
  async function loadTeacherPage(token=state.viewToken) {
    const root=byId("teacherResults");if(!root)return;
    root.innerHTML=`<div class="empty">Loading teachers</div>`;
    const data=await rpc("list_teachers",{
      search_text:byId("teacherSearch")?.value.trim()||"",
      status_filter:byId("teacherStatus")?.value||"",
      archive_filter:byId("teacherArchive")?.value||"active",
      page_number:state.teacherPage,page_size:CONFIG.pageSize
    });
    if(token!==state.viewToken||!byId("teacherResults"))return;
    state.teacherAdmin=data;
    const rows=data.rows||[];
    root.innerHTML=rows.length?`<div class="table-wrap"><table><thead><tr><th>Teacher</th><th>Staff No.</th><th>Contact</th><th>Qualification</th><th>Assignments</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map(row=>`<tr>
        <td><div class="cell-main"><span class="avatar small-avatar">${esc((row.first_name||"T").charAt(0).toUpperCase())}</span><div class="cell-copy"><strong>${esc(row.full_name)}</strong><small>${esc(row.profile_email||row.email||"No linked account")}</small></div></div></td>
        <td>${esc(row.staff_no)}</td><td><div class="cell-copy"><span>${esc(row.phone||"—")}</span><small>${esc(row.email||"")}</small></div></td>
        <td><div class="cell-copy"><span>${esc(row.qualification||"—")}</span><small>${esc(row.specialization||"")}</small></div></td>
        <td><div class="chip-list"><span class="chip">${number((row.class_assignments||[]).length)} classes</span><span class="chip">${number((row.subject_assignments||[]).length)} subjects</span></div></td>
        <td>${statusBadge(row.deleted_at?"archived":row.employment_status)}</td>
        <td><div class="table-actions"><button class="button secondary small" data-teacher-view="${attr(row.id)}">View</button>
          ${!row.deleted_at?`<button class="button ghost small" data-teacher-edit="${attr(row.id)}">Edit</button><button class="button danger small" data-teacher-archive="${attr(row.id)}">Remove</button>`:
          `<button class="button success small" data-teacher-restore="${attr(row.id)}">Restore</button>`}
        </div></td></tr>`).join("")}</tbody></table></div>${pagination(data.total,data.page,data.page_size,"teacher")}`:
      `<div class="empty"><strong>No teachers found</strong></div>`;
    $$("[data-teacher-view]",root).forEach(button=>button.onclick=()=>openTeacherRecord(button.dataset.teacherView));
    $$("[data-teacher-edit]",root).forEach(button=>button.onclick=()=>openTeacherEditor(button.dataset.teacherEdit));
    $$("[data-teacher-archive]",root).forEach(button=>button.onclick=()=>archiveTeacher(button.dataset.teacherArchive));
    $$("[data-teacher-restore]",root).forEach(button=>button.onclick=()=>restoreTeacher(button.dataset.teacherRestore));
    bindPagination("teacher",data);
  }
  async function openTeacherRecord(id) {
    const data=await rpc("get_teacher_record",{target_teacher_id:id});
    const t=data.teacher||{};
    modal(t.full_name||"Teacher",t.staff_no||"",`
      <div class="grid two">
        <section class="panel pad"><div class="metric"><span>Employment status</span><strong>${esc(t.employment_status||"—")}</strong></div>
          <div class="metric"><span>Telephone</span><strong>${esc(t.phone||"—")}</strong></div>
          <div class="metric"><span>Email</span><strong>${esc(t.email||"—")}</strong></div>
          <div class="metric"><span>Qualification</span><strong>${esc(t.qualification||"—")}</strong></div>
          <div class="metric"><span>Specialization</span><strong>${esc(t.specialization||"—")}</strong></div>
          <div class="metric"><span>Linked account</span><strong>${esc(t.profile_email||"—")}</strong></div></section>
        <section class="panel pad"><div class="section-title"><h4>Assignments</h4></div>
          ${(data.classes||[]).map(item=>`<div class="diff-row"><span>Class teacher</span><b>${esc(item.name)}</b></div>`).join("")}
          ${(data.subjects||[]).map(item=>`<div class="diff-row"><span>${esc(item.class_name)}</span><b>${esc(item.subject_name)}</b></div>`).join("")}
          ${!(data.classes||[]).length&&!(data.subjects||[]).length?`<div class="empty"><strong>No active assignments</strong></div>`:""}
        </section>
      </div>`,t.deleted_at?`<button class="button success" id="teacherRecordRestore" type="button">Restore teacher</button>`:
      `<button class="button primary" id="teacherRecordEdit" type="button">Edit teacher</button><button class="button danger" id="teacherRecordArchive" type="button">Remove teacher</button>`,"wide");
    byId("teacherRecordEdit")?.addEventListener("click",()=>{closeModal();openTeacherEditor(id)});
    byId("teacherRecordArchive")?.addEventListener("click",()=>{closeModal();archiveTeacher(id)});
    byId("teacherRecordRestore")?.addEventListener("click",()=>{closeModal();restoreTeacher(id)});
  }
  async function openTeacherEditor(id=null) {
    let row={gender:"Other",employment_status:"active",active:true};
    if(id){const data=await rpc("get_teacher_record",{target_teacher_id:id});row=data.teacher||row}
    else {try{row.staff_no=await rpc("generate_school_identifier",{identifier_kind:"teacher"})}catch(_){row.staff_no=""}}
    const profiles=(state.teacherAdmin?.profiles||[]).filter(profile=>["class_teacher","subject_teacher"].includes(profile.role)||profile.id===row.profile_id);
    modal(id?"Edit Teacher":"Add Teacher",row.staff_no||"",`<form id="teacherForm" class="form-stack">
      <input type="hidden" name="id" value="${attr(row.id||"")}">
      <input type="hidden" name="updated_at" value="${attr(row.updated_at||"")}">
      <div class="form-grid three">
        <label class="field"><span>Staff number</span><input name="staff_no" value="${attr(row.staff_no||"")}" readonly></label>
        <label class="field"><span>First name</span><input name="first_name" value="${attr(row.first_name||"")}" required></label>
        <label class="field"><span>Middle name</span><input name="middle_name" value="${attr(row.middle_name||"")}"></label>
        <label class="field"><span>Last name</span><input name="last_name" value="${attr(row.last_name||"")}" required></label>
        <label class="field"><span>Gender</span><select name="gender">${["Male","Female","Other"].map(v=>`<option value="${v}" ${v===row.gender?"selected":""}>${v}</option>`).join("")}</select></label>
        <label class="field"><span>Date joined</span><input type="date" name="date_joined" value="${attr(row.date_joined||"")}"></label>
        <label class="field"><span>Telephone</span><input name="phone" value="${attr(row.phone||"")}"></label>
        <label class="field"><span>Email</span><input type="email" name="email" value="${attr(row.email||"")}"></label>
        <label class="field"><span>Employment status</span><select name="employment_status">${["active","leave","suspended","resigned","retired"].map(v=>`<option value="${v}" ${v===row.employment_status?"selected":""}>${v.replaceAll("_"," ")}</option>`).join("")}</select></label>
        <label class="field"><span>Qualification</span><input name="qualification" value="${attr(row.qualification||"")}"></label>
        <label class="field"><span>Specialization</span><input name="specialization" value="${attr(row.specialization||"")}"></label>
        <label class="field"><span>Linked user account</span><select name="profile_id">${optionList(profiles,"id","full_name",row.profile_id,"No linked account")}</select></label>
        <label class="field full"><span>Address</span><input name="address" value="${attr(row.address||"")}"></label>
        <label class="field full"><span>Notes</span><textarea name="notes">${esc(row.notes||"")}</textarea></label>
        <label class="check-field full"><input type="checkbox" name="active" ${row.active!==false?"checked":""}><span>Active teacher</span></label>
      </div>
    </form>`,`<button class="button ghost" id="teacherCancel" type="button">Cancel</button><button class="button primary" id="teacherSave" type="submit" form="teacherForm">Save teacher</button>`,"wide");
    byId("teacherCancel").onclick=closeModal;
    byId("teacherForm").addEventListener("submit",event=>{event.preventDefault();saveTeacher()});
  }
  async function saveTeacher() {
    const form=byId("teacherForm"),button=byId("teacherSave");if(!form?.reportValidity()){toast("Teacher not saved","Complete the required teacher fields.","error");return}
    const v=formObject(form);button.disabled=true;button.textContent="Saving";let saved=false;
    try{
      await rpc("save_teacher",{payload:{...v,active:form.elements.active.checked,reason:v.id?"Teacher record updated":"Teacher record created"}});
      saved=true;state.workspace=null;closeModal();toast("Teacher record saved");
      try{state.boot=await rpc("get_bootstrap_data");renderBrand();renderNav();await loadTeacherPage()}
      catch(refreshError){await reportClientError(refreshError,{source:"teacher_save",stage:"refresh"});toast("Teacher saved","Reload the page to display the latest record.","warning",6500)}
    }catch(error){await reportClientError(error,{source:"teacher_save",stage:saved?"refresh":"record"});toast(saved?"Teacher saved":"Teacher not saved",saved?"Reload the page to display the latest record.":friendlyError(error),saved?"warning":"error",6500)}finally{button.disabled=false;button.textContent="Save teacher"}
  }
  async function archiveTeacher(id) {
    const ok=await confirmAction("Remove Teacher","The staff record will be archived and active class assignments will be cleared.","Remove",true);if(!ok)return;
    try{await rpc("archive_teacher",{target_teacher_id:id,reason_text:"Teacher removed from active records"});state.workspace=null;toast("Teacher removed");await loadTeacherPage()}
    catch(error){toast("Teacher not removed",friendlyError(error),"error")}
  }
  async function restoreTeacher(id) {
    const ok=await confirmAction("Restore Teacher","The staff record will return to the teacher directory.","Restore");if(!ok)return;
    try{await rpc("restore_teacher",{target_teacher_id:id,reason_text:"Teacher restored to active records"});state.workspace=null;toast("Teacher restored");await loadTeacherPage()}
    catch(error){toast("Teacher not restored",friendlyError(error),"error")}
  }
  async function exportTeachersCsv() {
    const data=await rpc("list_teachers",{search_text:byId("teacherSearch")?.value||"",status_filter:byId("teacherStatus")?.value||"",archive_filter:byId("teacherArchive")?.value||"active",page_number:1,page_size:100});
    const headers=["staff_no","first_name","middle_name","last_name","gender","phone","email","qualification","specialization","date_joined","employment_status"];
    downloadText("teachers.csv",[headers.join(","),...(data.rows||[]).map(row=>headers.map(h=>csvCell(row[h])).join(","))].join("\n"),"text/csv");
  }


  async function renderPrincipals(token) {
    byId("content").innerHTML=`
      <div class="page-head"><div><h3>Principal Directory</h3><p>Principal names, contacts, linked accounts, and digital signing</p></div>
        <div class="page-actions"><button class="button outline" id="headteacherExport">Export CSV</button><button class="button primary" id="headteacherAdd">Add principal</button></div></div>
      <section class="panel"><div class="toolbar">
        <label class="search"><input id="headteacherSearch" type="search" placeholder="Search full name, contact or staff number"></label>
        <select id="headteacherArchive"><option value="active">Current records</option><option value="archived">Removed records</option><option value="all">All records</option></select>
      </div><div id="headteacherResults"><div class="empty">Loading principals</div></div></section>`;
    byId("headteacherAdd").onclick=()=>openPrincipalEditor();byId("headteacherExport").onclick=exportPrincipalsCsv;let timer;
    byId("headteacherSearch").oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>{state.headteacherPage=1;loadPrincipalPage(token)},250)};
    byId("headteacherArchive").onchange=()=>{state.headteacherPage=1;loadPrincipalPage(token)};await loadPrincipalPage(token);
  }
  async function loadPrincipalPage(token=state.viewToken) {
    const root=byId("headteacherResults");if(!root)return;root.innerHTML=`<div class="empty">Loading principals</div>`;
    const data=await rpc("list_headteachers",{search_text:byId("headteacherSearch")?.value.trim()||"",status_filter:"",archive_filter:byId("headteacherArchive")?.value||"active",page_number:state.headteacherPage,page_size:CONFIG.pageSize});
    if(token!==state.viewToken||!byId("headteacherResults"))return;state.headteacherAdmin=data;const rows=data.rows||[];
    root.innerHTML=rows.length?`<div class="table-wrap"><table><thead><tr><th>Principal</th><th>Contact</th><th>Linked Account</th><th>Signature</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map(row=>`<tr><td><div class="cell-main"><span class="avatar small-avatar">${esc((row.full_name||"H").charAt(0).toUpperCase())}</span><div class="cell-copy"><strong>${esc(row.full_name)}</strong></div></div></td>
        <td>${esc(row.phone||"—")}</td><td>${esc(row.profile_email||"Not linked")}</td><td>${row.signature_path?`<span class="status published">Uploaded</span>`:`<span class="status draft">Not uploaded</span>`}</td>
        <td>${statusBadge(row.deleted_at?"archived":"active")}</td><td><div class="table-actions"><button class="button secondary small" data-headteacher-view="${attr(row.id)}">View</button>
          ${!row.deleted_at?`<button class="button ghost small" data-headteacher-edit="${attr(row.id)}">Edit</button><button class="button danger small" data-headteacher-archive="${attr(row.id)}">Remove</button>`:`<button class="button success small" data-headteacher-restore="${attr(row.id)}">Restore</button>`}</div></td></tr>`).join("")}</tbody></table></div>${pagination(data.total,data.page,data.page_size,"principal")}`:`<div class="empty"><strong>No principals found</strong></div>`;
    $$('[data-headteacher-view]',root).forEach(button=>button.onclick=()=>openPrincipalRecord(button.dataset.headteacherView));
    $$('[data-headteacher-edit]',root).forEach(button=>button.onclick=()=>openPrincipalEditor(button.dataset.headteacherEdit));
    $$('[data-headteacher-archive]',root).forEach(button=>button.onclick=()=>archivePrincipal(button.dataset.headteacherArchive));
    $$('[data-headteacher-restore]',root).forEach(button=>button.onclick=()=>restorePrincipal(button.dataset.headteacherRestore));bindPagination("principal",data);
  }
  async function openPrincipalRecord(id) {
    const data=await rpc("get_headteacher_record",{target_headteacher_id:id}),h=data.headteacher||{};
    modal(h.full_name||"Principal","",`<div class="grid two"><section class="panel pad"><div class="metric"><span>Full name</span><strong>${esc(h.full_name||"—")}</strong></div><div class="metric"><span>Contact</span><strong>${esc(h.phone||"—")}</strong></div><div class="metric"><span>Linked account</span><strong>${esc(h.profile_email||"Not linked")}</strong></div></section>
      <section class="panel pad"><div class="metric"><span>Digital signature</span><strong>${h.signature_path?"Uploaded":"Not uploaded"}</strong></div><p class="muted">The linked Principal uploads and manages the signature from the Principal Dashboard.</p></section></div>`,h.deleted_at?`<button class="button success" id="headteacherRecordRestore" type="button">Restore principal</button>`:`<button class="button primary" id="headteacherRecordEdit" type="button">Edit principal</button><button class="button danger" id="headteacherRecordArchive" type="button">Remove principal</button>`,"wide");
    byId("headteacherRecordEdit")?.addEventListener("click",()=>{closeModal();openPrincipalEditor(id)});byId("headteacherRecordArchive")?.addEventListener("click",()=>{closeModal();archivePrincipal(id)});byId("headteacherRecordRestore")?.addEventListener("click",()=>{closeModal();restorePrincipal(id)});
  }
  async function openPrincipalEditor(id=null) {
    let row={active:true};if(id){const data=await rpc("get_headteacher_record",{target_headteacher_id:id});row=data.headteacher||row}else{try{row.staff_no=await rpc("generate_school_identifier",{identifier_kind:"principal"})}catch(_){row.staff_no=""}}
    modal(id?"Edit Principal":"Add Principal","",`<form id="headteacherForm" class="form-stack"><input type="hidden" name="id" value="${attr(row.id||"")}"><input type="hidden" name="updated_at" value="${attr(row.updated_at||"")}"><input type="hidden" name="profile_id" value="${attr(row.profile_id||"")}"><input type="hidden" name="staff_no" value="${attr(row.staff_no||"")}">
      <div class="form-grid"><label class="field full"><span>Full name</span><input name="full_name" value="${attr(row.full_name||fullName(row)||"")}" required></label><label class="field full"><span>Contact</span><input name="contact" value="${attr(row.phone||"")}" required></label></div></form>`,
      `<button class="button ghost" id="headteacherCancel" type="button">Cancel</button><button class="button primary" id="headteacherSave" type="submit" form="headteacherForm">Save principal</button>`,"small");
    byId("headteacherCancel").onclick=closeModal;byId("headteacherForm").addEventListener("submit",event=>{event.preventDefault();savePrincipal()});
  }
  async function savePrincipal() {
    const form=byId("headteacherForm"),button=byId("headteacherSave");if(!form?.reportValidity()){toast("Principal not saved","Enter the full name and contact.","error");return}
    const v=formObject(form);button.disabled=true;button.textContent="Saving";let saved=false;try{await rpc("save_headteacher",{payload:{...v,reason:v.id?"Principal record updated":"Principal record created"}});saved=true;state.workspace=null;closeModal();toast("Principal record saved");try{state.boot=await rpc("get_bootstrap_data");renderBrand();renderNav();await loadPrincipalPage()}catch(refreshError){await reportClientError(refreshError,{source:"headteacher_save",stage:"refresh"});toast("Principal saved","Reload the page to display the latest record.","warning",6500)}}catch(error){await reportClientError(error,{source:"headteacher_save",stage:saved?"refresh":"record"});toast(saved?"Principal saved":"Principal not saved",saved?"Reload the page to display the latest record.":friendlyError(error),saved?"warning":"error",6500)}finally{button.disabled=false;button.textContent="Save principal"}
  }
  async function archivePrincipal(id) {const ok=await confirmAction("Remove Principal","The record will be archived while audit history and published reports remain preserved.","Remove",true);if(!ok)return;try{await rpc("archive_headteacher",{target_headteacher_id:id,reason_text:"Principal removed from active records"});state.workspace=null;toast("Principal removed");await loadPrincipalPage()}catch(error){toast("Principal not removed",friendlyError(error),"error")}}
  async function restorePrincipal(id) {const ok=await confirmAction("Restore Principal","The principal record will return to the active directory.","Restore");if(!ok)return;try{await rpc("restore_headteacher",{target_headteacher_id:id,reason_text:"Principal restored to active records"});state.workspace=null;toast("Principal restored");await loadPrincipalPage()}catch(error){toast("Principal not restored",friendlyError(error),"error")}}
  async function exportPrincipalsCsv() {const data=await rpc("list_headteachers",{search_text:byId("headteacherSearch")?.value||"",status_filter:"",archive_filter:byId("headteacherArchive")?.value||"active",page_number:1,page_size:100});const headers=["staff_no","full_name","phone","profile_email"];downloadText("principals.csv",[headers.join(","),...(data.rows||[]).map(row=>headers.map(h=>csvCell(row[h])).join(","))].join("\n"),"text/csv")}

  async function renderUsers(token) {
    const data=await rpc("list_profiles_with_access");
    if(token!==state.viewToken)return;
    state.userAdmin=data;
    byId("content").innerHTML=`
      <div class="page-head"><div><h3>Users and Access</h3><p>Accounts, credentials, roles, classes, and security</p></div>
        <div class="page-actions"><button class="button primary" id="userAdd">Create user</button></div></div>
      <section class="panel">
        <div class="toolbar"><label class="search"><input id="userSearch" type="search" placeholder="Search name or email"></label>
          <select id="userRoleFilter"><option value="">All roles</option>${["system_admin","principal","class_teacher","subject_teacher","parent_guardian"].map(r=>`<option value="${r}">${esc(ROLE_LABELS[r])}</option>`).join("")}</select>
          <select id="userStatusFilter"><option value="">All accounts</option><option value="active">Active</option><option value="inactive">Inactive</option></select></div>
        <div id="userResults"></div>
      </section>`;
    byId("userAdd").onclick=()=>openUserEditor();
    ["userSearch","userRoleFilter","userStatusFilter"].forEach(id=>byId(id).addEventListener(id==="userSearch"?"input":"change",renderUserRows));
    renderUserRows();
  }
  function renderUserRows() {
    const root=byId("userResults");if(!root)return;
    const search=(byId("userSearch")?.value||"").trim().toLowerCase(),roleFilter=byId("userRoleFilter")?.value||"",status=byId("userStatusFilter")?.value||"";
    const rows=(state.userAdmin?.profiles||[]).filter(user=>{
      if(search&&!`${user.full_name||""} ${user.email||""} ${user.phone||""}`.toLowerCase().includes(search))return false;
      if(roleFilter&&user.role!==roleFilter)return false;
      if(status==="active"&&!user.active)return false;
      if(status==="inactive"&&user.active)return false;
      return true;
    });
    root.innerHTML=rows.length?`<div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Account</th><th>MFA</th><th>Class Access</th><th>Last Seen</th><th></th></tr></thead><tbody>
      ${rows.map(user=>`<tr>
        <td><div class="cell-copy"><strong>${esc(user.full_name||"Unnamed user")}</strong><small>${esc(user.email||user.phone||"")}${user.staff_no?` • ${esc(user.staff_no)}`:""}</small></div></td>
        <td>${esc(ROLE_LABELS[user.role]||user.role)}</td>
        <td>${user.active?`<span class="status published">Active</span>`:`<span class="status withdrawn">Inactive</span>`}</td>
        <td>${user.mfa_required?`<span class="status approved">Required</span>`:`<span class="status draft">Optional</span>`}</td>
        <td>${(user.access||[]).length?`<div class="chip-list">${user.access.slice(0,3).map(a=>`<span class="chip">${esc(a.class_name)}${a.subject_name?` • ${esc(a.subject_name)}`:""}</span>`).join("")}${user.access.length>3?`<span class="chip">+${user.access.length-3}</span>`:""}</div>`:"School role"}</td>
        <td>${isoDateTime(user.last_seen_at||user.last_sign_in_at)}</td><td><div class="table-actions"><button class="button ghost small" data-user-edit="${attr(user.id)}">Edit</button>${user.id!==state.boot.profile.id?`<button class="button danger small" data-user-delete="${attr(user.id)}">Delete</button>`:""}</div></td>
      </tr>`).join("")}</tbody></table></div>`:`<div class="empty"><strong>No users found</strong></div>`;
    $$("[data-user-edit]",root).forEach(button=>button.onclick=()=>openUserEditor(button.dataset.userEdit));
    $$("[data-user-delete]",root).forEach(button=>button.onclick=()=>deleteUserAccount(button.dataset.userDelete));
  }
  const NIP_EMAIL_TITLES=new Set(["mr","mrs","ms","miss","madam","master","dr","doctor","rev","reverend","prof","professor","principal","headmaster","headmistress"]);
  let userEmailPreviewTimer=0,userEmailPreviewToken=0;
  function nipEmailBase(fullNameValue) {
    const parts=String(fullNameValue||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().split(/\s+/)
      .map(part=>part.replace(/[^a-z0-9]/g,"")).filter(Boolean);
    return parts.find(part=>!NIP_EMAIL_TITLES.has(part))||parts[0]||"";
  }
  function generatedNipEmail(fullNameValue) {
    const base=nipEmailBase(fullNameValue);return base?`${base}@nip.com`:"";
  }
  async function refreshGeneratedUserEmail(userId=null) {
    const form=byId("userForm"),input=form?.elements?.email;if(!form||!input||userId)return;
    const base=nipEmailBase(form.elements.full_name.value),fallback=base?`${base}@nip.com`:"";
    input.value=fallback;
    if(!base||!state.boot?.profile?.id)return;
    const token=++userEmailPreviewToken;
    try{
      const resolved=await rpc("generate_nip_user_email",{actor_id:state.boot.profile.id,requested_base:base,target_user_id:null});
      if(token===userEmailPreviewToken&&byId("userForm")===form)input.value=String(resolved||fallback);
    }catch(_){/* The protected Edge Function performs the authoritative generation. */}
  }
  function scheduleGeneratedUserEmail(userId=null) {
    clearTimeout(userEmailPreviewTimer);
    userEmailPreviewTimer=setTimeout(()=>refreshGeneratedUserEmail(userId),220);
  }

  function openUserEditor(id=null) {
    const user=id?(state.userAdmin.profiles||[]).find(x=>x.id===id):{role:"parent_guardian",active:true,mfa_required:false,access:[]};if(!user)return;
    const initialEmail=id?(user.email||generatedNipEmail(user.full_name||"")):generatedNipEmail(user.full_name||"");
    state.userAccessRows=(user.access||[]).map(x=>({...x}));
    modal(id?"Edit User Account":"Create User Account",user.email||"",`<form id="userForm" class="form-stack">
      <div class="form-grid">
        <label class="field full hidden" id="userStaffField"><span id="userStaffLabel">Staff record</span><select id="userStaffSelect" name="staff_record_id"></select></label>
        <label class="field"><span>Full name</span><input name="full_name" value="${attr(user.full_name||"")}" required></label>
        <label class="field"><span>Email address</span><input name="email" type="email" value="${attr(initialEmail)}" readonly required></label>
        <label class="field"><span>Telephone</span><input name="phone" value="${attr(user.phone||"")}"></label>
        <label class="field"><span>Role</span><select id="userRoleSelect" name="role">
          ${["system_admin","principal","class_teacher","subject_teacher","parent_guardian"].map(r=>`<option value="${r}" ${r===user.role?"selected":""}>${esc(ROLE_LABELS[r])}</option>`).join("")}
        </select></label>
        <label class="field full"><span>${id?"New password":"Password"}</span><div class="password-wrap"><input id="adminUserPassword" name="password" type="password" autocomplete="new-password" ${id?"":"required"}><button id="generateUserPassword" class="button ghost small" type="button">Generate</button></div></label>
        <label class="check-field"><input name="active" type="checkbox" ${user.active!==false?"checked":""}><span>Active account</span></label>
        <label class="check-field"><input name="mfa_required" type="checkbox" ${user.mfa_required?"checked":""}><span>Require multi-factor authentication</span></label>
      </div>
      <div id="userAccessSection"><div class="section-title"><h4>Delegated Class Access</h4><button class="button secondary small" id="userAccessAdd" type="button">Add access</button></div><div id="userAccessRows"></div></div>
    </form>`,`<button class="button ghost" id="userCancel" type="button">Cancel</button><button class="button primary" id="userSave" type="button">${id?"Save account":"Create account"}</button>`,"wide");
    renderUserAccessRows();
    renderUserStaffSelector(id||"",user.headteacher_id||user.teacher_id||"");
    const userForm=byId("userForm");
    userForm.elements.full_name.addEventListener("input",()=>scheduleGeneratedUserEmail(id));
    if(!id)scheduleGeneratedUserEmail(null);
    byId("generateUserPassword").onclick=()=>{const password=generateSecurePassword();byId("adminUserPassword").value=password;byId("adminUserPassword").type="text"};
    byId("userRoleSelect").onchange=()=>{
      const selected=byId("userRoleSelect").value;
      state.userAccessRows=state.userAccessRows.map(row=>selected==="subject_teacher"?{...row,access_level:row.access_level==="view"?"score":row.access_level}:{...row,access_level:selected==="class_teacher"&&row.access_level==="view"?"edit":row.access_level});
      renderUserAccessRows();renderUserStaffSelector(id||"","");
    };
    byId("userAccessAdd").onclick=()=>{const selected=byId("userRoleSelect").value;state.userAccessRows.push({class_id:"",subject_id:"",access_level:selected==="subject_teacher"?"score":selected==="class_teacher"?"edit":"view"});renderUserAccessRows()};
    byId("userCancel").onclick=closeModal;
    byId("userSave").onclick=()=>saveUserAccount(id);
  }

  function staffRecordsForUserRole(roleName,userId="") {
    const source=roleName==="principal"?(state.userAdmin?.headteacher_records||[]):
      (["class_teacher","subject_teacher"].includes(roleName)?(state.userAdmin?.teacher_records||[]):[]);
    return source.filter(record=>!record.profile_id||record.profile_id===userId);
  }
  function renderUserStaffSelector(userId="",selectedId="") {
    const roleName=byId("userRoleSelect")?.value||"parent_guardian",field=byId("userStaffField"),select=byId("userStaffSelect"),label=byId("userStaffLabel");
    if(!field||!select||!label)return;
    const requiredRole=["principal","class_teacher","subject_teacher"].includes(roleName);
    field.classList.toggle("hidden",!requiredRole);select.required=requiredRole;
    if(!requiredRole){select.innerHTML='<option value="">Not applicable</option>';select.value="";return}
    const rows=staffRecordsForUserRole(roleName,userId);
    label.textContent=roleName==="principal"?"Principal record":"Teacher record";
    select.innerHTML=optionList(rows,"id","label",selectedId,roleName==="principal"?"Select principal":"Select teacher");
    if(selectedId&&rows.some(row=>row.id===selectedId))select.value=selectedId;
    select.onchange=()=>{
      const record=rows.find(item=>item.id===select.value);if(!record)return;
      const form=byId("userForm");if(!form)return;
      form.elements.full_name.value=record.full_name||"";
      if(!userId)scheduleGeneratedUserEmail(null);
      if(record.phone)form.elements.phone.value=record.phone;
    };
  }

  function generateSecurePassword(length=14) {
    const sets=["ABCDEFGHJKLMNPQRSTUVWXYZ","abcdefghijkmnopqrstuvwxyz","23456789","!@#$%&*"];
    const values=new Uint32Array(length);crypto.getRandomValues(values);
    const chars=sets.map((set,index)=>set[values[index]%set.length]);
    const all=sets.join("");for(let i=chars.length;i<length;i++)chars.push(all[values[i]%all.length]);
    for(let i=chars.length-1;i>0;i--){const j=values[i]% (i+1);[chars[i],chars[j]]=[chars[j],chars[i]]}
    return chars.join("");
  }
  function renderUserAccessRows() {
    const root=byId("userAccessRows"),section=byId("userAccessSection");if(!root)return;const teacherRole=["class_teacher","subject_teacher"].includes(byId("userRoleSelect")?.value);if(section)section.classList.toggle("hidden",!teacherRole);if(!teacherRole){state.userAccessRows=[];root.innerHTML="";return;}
    root.innerHTML=state.userAccessRows.length?state.userAccessRows.map((row,index)=>{const assignedIds=new Set((state.userAdmin.class_subjects||[]).filter(item=>item.class_id===row.class_id&&item.active!==false).map(item=>item.subject_id));const choices=(state.userAdmin.subjects||[]).filter(item=>!row.class_id||assignedIds.has(item.id));return `<div class="form-grid three" data-access-index="${index}" style="margin-bottom:10px">
      <label class="field"><span>Class</span><select data-access-key="class_id">${optionList(state.userAdmin.classes||[],"id","name",row.class_id)}</select></label>
      <label class="field"><span>Subject</span><select data-access-key="subject_id">${optionList(choices,"id","name",row.subject_id,"All subjects")}</select></label>
      <div class="button-row"><label class="field" style="flex:1"><span>Access</span><select data-access-key="access_level">
        ${["view","edit","score","review"].map(v=>`<option value="${v}" ${v===row.access_level?"selected":""}>${v}</option>`).join("")}</select></label>
        <button class="button danger small" type="button" data-access-remove="${index}">Remove</button></div>
    </div>`}).join(""):`<div class="empty compact-empty"><strong>No delegated class access</strong></div>`;
    $$("[data-access-index]",root).forEach(line=>$$("[data-access-key]",line).forEach(input=>input.onchange=()=>{
      const access=state.userAccessRows[Number(line.dataset.accessIndex)];access[input.dataset.accessKey]=input.value;
      if(input.dataset.accessKey==="class_id"){access.subject_id="";renderUserAccessRows()}
    }));
    $$("[data-access-remove]",root).forEach(button=>button.onclick=()=>{state.userAccessRows.splice(Number(button.dataset.accessRemove),1);renderUserAccessRows()});
  }
  async function invokeAdminUserManagement(action,payload) {
    let {data:{session}}=await state.client.auth.getSession();
    if(!session)throw new Error("Your session has expired. Sign in again.");
    if(Number(session.expires_at||0)*1000-Date.now()<90000){
      const refreshed=await state.client.auth.refreshSession();session=refreshed.data.session||session;state.session=session;
    }
    const {data,error}=await state.client.functions.invoke("admin-user-management",{
      body:{action,payload},headers:{Authorization:`Bearer ${session.access_token}`}
    });
    if(error){
      let message=error.message||"User account operation failed";
      try{const detail=await error.context?.json();if(detail?.error)message=String(detail.error)}catch(_){}
      throw new Error(message.replaceAll("_"," "));
    }
    if(data?.error)throw new Error(String(data.error).replaceAll("_"," "));
    return data;
  }
  async function saveUserAccount(userId=null) {
    const form=byId("userForm"),button=byId("userSave");if(!form?.reportValidity())return;
    const v=formObject(form);button.disabled=true;button.textContent=userId?"Saving":"Creating";let saved=false;
    try{
      if(!userId&&String(v.password||"").length<8)throw new Error("Password must contain at least 8 characters");
      if(userId&&v.password&&String(v.password).length<8)throw new Error("Password must contain at least 8 characters");
      if(["principal","class_teacher","subject_teacher"].includes(v.role)&&!v.staff_record_id)throw new Error("Select the corresponding staff record");
      const payload={user_id:userId||undefined,full_name:v.full_name.trim(),email:v.email.trim(),phone:v.phone.trim(),role:v.role,staff_record_id:v.staff_record_id||"",
        password:v.password||"",active:form.elements.active.checked,mfa_required:form.elements.mfa_required.checked,
        access:state.userAccessRows.filter(x=>x.class_id),reason:userId?"User account updated":"User account created"};
      await invokeAdminUserManagement(userId?"update":"create",payload);saved=true;state.workspace=null;closeModal();toast(userId?"User account saved":"User account created");
      try{state.userAdmin=await rpc("list_profiles_with_access");state.boot=await rpc("get_bootstrap_data");renderBrand();renderNav();renderUserRows()}
      catch(refreshError){await reportClientError(refreshError,{source:"user_account_save",user_id:userId,stage:"refresh"});toast("Account saved","Reload the page to display the latest access record.","warning",6500)}
    }catch(error){await reportClientError(error,{source:"user_account_save",user_id:userId,stage:saved?"refresh":"record"});toast(saved?"Account saved":"User account not saved",saved?"Reload the page to display the latest access record.":friendlyError(error),saved?"warning":"error",6500)}finally{button.disabled=false;button.textContent=userId?"Save account":"Create account"}
  }

  async function deleteUserAccount(userId) {
    const user=(state.userAdmin?.profiles||[]).find(item=>item.id===userId);if(!user)return;
    const ok=await confirmAction("Delete User Account",`Permanently delete ${user.full_name||user.email||"this account"}? The linked staff record will remain but will no longer have a login.`,"Delete",true);if(!ok)return;
    try{
      await invokeAdminUserManagement("delete",{user_id:userId,reason:"User account permanently deleted by the System Administrator"});
      toast("User account deleted");state.workspace=null;
      state.userAdmin=await rpc("list_profiles_with_access");state.boot=await rpc("get_bootstrap_data");renderBrand();renderNav();renderUserRows();
    }catch(error){toast("User account not deleted",friendlyError(error),"error",6500)}
  }

  async function renderNotifications(token) {
    const data=await rpc("list_notifications",{page_number:1,page_size:100});
    if(token!==state.viewToken)return;
    state.notifications=data.rows||[];
    byId("content").innerHTML=`
      <div class="page-head"><div><h3>Notifications</h3><p>${number(data.unread)} unread • ${number(data.total)} total</p></div>
        <div class="page-actions">${data.unread?`<button class="button secondary" id="markAllRead">Mark all read</button>`:""}${state.notifications.length?`<button class="button danger" id="clearNotifications">Clear notifications</button>`:""}</div></div>
      <section class="panel">
        ${state.notifications.length?state.notifications.map(item=>`<div class="panel-header" data-notification-id="${attr(item.id)}" style="${item.read_at?"opacity:.7":""}">
          <div><h4>${esc(item.title)}</h4><p>${esc(item.body)} • ${isoDateTime(item.created_at)}</p></div>
          <div class="button-row">${item.entity_type==="report"&&item.entity_id?`<button class="button outline small" data-notification-report="${attr(item.entity_id)}">Open</button>`:""}
            ${!item.read_at?`<button class="button ghost small" data-notification-read="${attr(item.id)}">Mark read</button>`:""}<button class="button danger small" data-notification-delete="${attr(item.id)}">Delete</button></div>
        </div>`).join(""):`<div class="empty"><strong>No notifications</strong></div>`}
      </section>`;
    byId("markAllRead")?.addEventListener("click",async()=>{await rpc("mark_notifications_read",{notification_ids:null});await loadNotificationCount();renderNotifications(state.viewToken,true)});
    byId("clearNotifications")?.addEventListener("click",async()=>{if(!await confirmAction("Clear Notifications","Delete all notifications for this account?","Clear",true))return;await rpc("delete_notifications",{notification_ids:null});await loadNotificationCount();renderNotifications(state.viewToken,true)});
    $$('[data-notification-read]').forEach(button=>button.onclick=async()=>{await rpc("mark_notifications_read",{notification_ids:[button.dataset.notificationRead]});await loadNotificationCount();renderNotifications(state.viewToken,true)});
    $$('[data-notification-delete]').forEach(button=>button.onclick=async()=>{if(!await confirmAction("Delete Notification","Remove this notification?","Delete",true))return;await rpc("delete_notifications",{notification_ids:[button.dataset.notificationDelete]});await loadNotificationCount();renderNotifications(state.viewToken,true)});
    $$('[data-notification-report]').forEach(button=>button.onclick=()=>openReportEditor(button.dataset.notificationReport));
  }

  async function renderAudit(token) {
    const data=await rpc("list_audit_events",{target_table:null,target_record_id:null,page_number:1,page_size:100});
    if(token!==state.viewToken)return;
    state.audit=data;
    const tables=[...new Set((data.rows||[]).map(x=>x.table_name))].sort();
    byId("content").innerHTML=`
      <div class="page-head"><div><h3>Audit Trail</h3><p>${number(data.total)} recorded changes</p></div><div class="page-actions"><button class="button danger" id="auditReset">Reset audit log</button></div></div>
      <section class="panel">
        <div class="toolbar"><select id="auditTable"><option value="">All records</option>${tables.map(t=>`<option value="${attr(t)}">${esc(t.replaceAll("_"," "))}</option>`).join("")}</select></div>
        <div id="auditRows">${auditRows(data.rows||[])}</div>
      </section>`;
    byId("auditTable").onchange=async()=>{
      const filtered=await rpc("list_audit_events",{target_table:byId("auditTable").value||null,target_record_id:null,page_number:1,page_size:100});
      state.audit=filtered;byId("auditRows").innerHTML=auditRows(filtered.rows||[]);bindAuditRows();
    };
    byId("auditReset").onclick=resetAuditLog;
    bindAuditRows();
  }
  function auditRows(rows) {
    return rows.length?`<div class="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Record</th><th>Action</th><th>Reason</th><th></th></tr></thead><tbody>
      ${rows.map((row,index)=>`<tr><td>${isoDateTime(row.created_at)}</td><td>${esc(row.actor_name||"System")}</td><td>${esc(row.table_name)}<br><small>${esc(row.record_id||"")}</small></td>
      <td><span class="chip">${esc(row.action)}</span></td><td>${esc(row.reason||"")}</td><td><div class="table-actions"><button class="button ghost small" data-audit-index="${index}">Details</button><button class="button danger small" data-audit-delete="${attr(row.id)}">Delete</button></div></td></tr>`).join("")}
    </tbody></table></div>`:`<div class="empty"><strong>No audit events</strong></div>`;
  }
  function bindAuditRows() {
    $$('[data-audit-index]').forEach(button=>button.onclick=()=>{
      const row=(state.audit.rows||[])[Number(button.dataset.auditIndex)];
      modal("Audit Event",`${row.table_name} • ${row.action}`,`<div class="revision-compare"><div class="diff-card"><h4>Before</h4><pre>${esc(JSON.stringify(row.old_data,null,2))}</pre></div><div class="diff-card"><h4>After</h4><pre>${esc(JSON.stringify(row.new_data,null,2))}</pre></div></div>`,`<button class="button ghost" id="auditClose" type="button">Close</button>`,"wide");
      byId("auditClose").onclick=closeModal;
    });
    $$('[data-audit-delete]').forEach(button=>button.onclick=async()=>{if(!await confirmAction("Delete Audit Event","Remove this audit event permanently?","Delete",true))return;await rpc("delete_audit_events",{event_ids:[Number(button.dataset.auditDelete)]});toast("Audit event deleted");await renderAudit(state.viewToken,true)});
  }
  async function resetAuditLog() {
    modal("Reset Audit Log","This permanently deletes the current audit trail.",`<div class="form-stack"><p class="help-text">Type <strong>RESET AUDIT LOG</strong> to confirm.</p><label class="field"><span>Confirmation</span><input id="auditResetConfirm" autocomplete="off"></label></div>`,`<button class="button ghost" id="auditResetCancel" type="button">Cancel</button><button class="button danger" id="auditResetRun" type="button">Reset audit log</button>`,"small");
    byId("auditResetCancel").onclick=closeModal;
    byId("auditResetRun").onclick=async()=>{const value=byId("auditResetConfirm").value;try{const result=await rpc("reset_audit_log",{confirmation_text:value});closeModal();toast("Audit log reset",`${number(result.deleted)} events deleted`);await renderAudit(state.viewToken,true)}catch(error){toast("Audit log not reset",friendlyError(error),"error")}};
  }

  async function renderSettings(token) {
    const school=state.boot.school||{};
    let health=null,readiness=null;
    try{health=await rpc("system_health")}catch(_){}
    if(can("manage_academics")||can("manage_users")){try{readiness=await rpc("validate_operational_readiness")}catch(_){}}
    if(token!==state.viewToken)return;
    byId("content").innerHTML=`
      <div class="page-head"><div><h3>System Settings</h3><p>School identity, security, health, and continuity</p></div></div>
      <div class="grid two">
        <section class="panel pad">
          <div class="section-title"><h4>School Identity</h4></div>
          <form id="schoolForm" class="form-grid">
            <label class="field full"><span>School name</span><input name="school_name" value="${attr(school.school_name||"")}" ${!can("manage_users")?"disabled":""}></label>
            <label class="field full"><span>Motto</span><input name="motto" value="${attr(school.motto||"")}" ${!can("manage_users")?"disabled":""}></label>
            <label class="field full"><span>Address</span><input name="address" value="${attr(school.address||"")}" ${!can("manage_users")?"disabled":""}></label>
            <label class="field"><span>Telephone</span><input name="phone" value="${attr(school.phone||"")}" ${!can("manage_users")?"disabled":""}></label>
            <label class="field"><span>Email</span><input type="email" name="email" value="${attr(school.email||"")}" ${!can("manage_users")?"disabled":""}></label>
            <label class="field"><span>Website</span><input name="website" value="${attr(school.website||"")}" ${!can("manage_users")?"disabled":""}></label>
            <label class="field"><span>Principal</span><input name="head_name" value="${attr(school.head_name||"")}" ${!can("manage_users")?"disabled":""}></label>
            <label class="field"><span>Report number prefix</span><input name="report_number_prefix" value="${attr(school.report_number_prefix||"NIS")}" ${!can("manage_users")?"disabled":""}></label>
            <label class="field"><span>Time zone</span><input name="timezone" value="${attr(school.timezone||"Africa/Accra")}" ${!can("manage_users")?"disabled":""}></label>
            <label class="field full"><span>Verification base URL</span><input name="verification_base_url" value="${attr(school.verification_base_url||"")}" ${!can("manage_users")?"disabled":""}></label>
            <label class="field"><span>Primary colour</span><input type="color" name="primary_colour" value="${attr(school.primary_colour||"#082d70")}" ${!can("manage_users")?"disabled":""}></label>
            <label class="field"><span>Accent colour</span><input type="color" name="accent_colour" value="${attr(school.accent_colour||"#f0b51d")}" ${!can("manage_users")?"disabled":""}></label>
            ${can("manage_users")?`<div class="full"><button class="button primary" id="schoolSave" type="button">Save identity</button></div>`:""}
          </form>
        </section>
        <div class="grid">
          <section class="panel pad"><div class="section-title"><h4>Account Security</h4></div>
            <div class="metric-row"><div class="metric"><span>Role</span><strong>${esc(ROLE_LABELS[role()]||role())}</strong></div>
              <div class="metric"><span>MFA policy</span><strong>${state.boot.profile.mfa_required?"Required":"Optional"}</strong></div></div>
            <div class="button-row" style="margin-top:15px"><button class="button secondary" id="mfaManage">Manage authentication</button></div>
          </section>
          <section class="panel pad"><div class="section-title"><h4>System Health</h4><button class="button ghost small" id="healthRefresh">Refresh</button></div>
            ${health?`<div class="metric-row">
              <div class="metric"><span>Active users</span><strong>${number(health.active_users)}</strong></div>
              <div class="metric"><span>Active teachers</span><strong>${number(health.active_teachers)}</strong></div>
              <div class="metric"><span>Active students</span><strong>${number(health.active_students)}</strong></div>
              <div class="metric"><span>Pending messages</span><strong>${number(health.pending_notifications)}</strong></div>
              <div class="metric"><span>Errors, 24h</span><strong>${number(health.client_errors_24h)}</strong></div>
            </div><div class="hr"></div>
            <div class="diff-row"><span>Latest backup</span><b>${isoDateTime(health.latest_backup)}</b></div>
            <div class="diff-row"><span>Published reports without PDF</span><b>${number(health.published_without_pdf)}</b></div>
            <div class="diff-row"><span>Incomplete assessment schemes</span><b>${number((health.incomplete_schemes||[]).length)}</b></div>
            ${readiness?`<div class="diff-row"><span>Record save services</span><b>${readiness.ready?"Operational":"Attention required"}</b></div><div class="diff-row"><span>Data security</span><b>${Object.values(readiness.rls||{}).every(Boolean)?"Protected":"Attention required"}</b></div><div class="diff-row"><span>Data integrity</span><b>${Object.values(readiness.integrity||{}).every(value=>Number(value)===0)?"Healthy":"Attention required"}</b></div><div class="diff-row"><span>Role portals</span><b>${Object.values(readiness.roles||{}).every(Boolean)?"Ready":"Attention required"}</b></div>`:""}`:`<p class="help-text">Health details are not available for this role.</p>`}
          </section>
          ${can("run_backup")?`<section class="panel pad"><div class="section-title"><h4>Backup and Recovery</h4></div>
            <div class="button-row"><button class="button primary" id="backupCreate">Create protected backup</button></div></section>`:""}
          ${can("manage_academics")?`<section class="panel pad"><div class="section-title"><h4>Scheduled Operations</h4></div>
            <div class="button-row"><button class="button secondary" id="notifyIncomplete">Queue incomplete-report alerts</button></div></section>`:""}
        </div>
      </div>`;
    byId("schoolSave")?.addEventListener("click",saveSchoolSettings);
    byId("mfaManage").onclick=openMfaManager;
    byId("healthRefresh")?.addEventListener("click",()=>renderSettings(state.viewToken,true));
    byId("backupCreate")?.addEventListener("click",createManualBackup);
    byId("notifyIncomplete")?.addEventListener("click",queueIncompleteNotifications);
  }
  async function saveSchoolSettings() {
    const form=byId("schoolForm"),values=formObject(form),button=byId("schoolSave");button.disabled=true;
    try{
      await query(state.client.from("school_settings").update(values).eq("id",state.boot.school.id));
      state.boot=await rpc("get_bootstrap_data");renderBrand();toast("School identity saved");
    }catch(error){toast("Settings not saved",friendlyError(error),"error")}finally{button.disabled=false}
  }
  async function openMfaManager() {
    const {data,error}=await state.client.auth.mfa.listFactors();if(error){toast("Security details unavailable",friendlyError(error),"error");return}
    const factors=data.totp||[];
    modal("Multi-factor Authentication","",`
      <div class="section-title"><h4>Authenticator Factors</h4></div>
      ${factors.length?factors.map(f=>`<div class="diff-row"><span><strong>${esc(f.friendly_name||"Authenticator")}</strong><br><small>${esc(f.status)}</small></span>
        <button class="button danger small" data-mfa-remove="${attr(f.id)}">Remove</button></div>`).join(""):`<div class="empty"><strong>No authenticator factor</strong></div>`}`,
      `<button class="button ghost" id="mfaManagerClose" type="button">Close</button><button class="button primary" id="mfaManagerAdd" type="button">Add authenticator</button>`,"small");
    byId("mfaManagerClose").onclick=closeModal;
    byId("mfaManagerAdd").onclick=enrollMfaFromSettings;
    $$("[data-mfa-remove]").forEach(button=>button.onclick=async()=>{
      if(!await confirmAction("Remove Authenticator","This authentication factor will be removed.","Remove",true))return;
      const {error}=await state.client.auth.mfa.unenroll({factorId:button.dataset.mfaRemove});
      if(error)toast("Authenticator not removed",friendlyError(error),"error");else{closeModal();toast("Authenticator removed")}
    });
  }
  async function enrollMfaFromSettings() {
    const {data,error}=await state.client.auth.mfa.enroll({factorType:"totp",friendlyName:"Nipe International School"});
    if(error){toast("Authenticator not added",friendlyError(error),"error");return}
    modal("Add Authenticator","",`<div class="mfa-qr"><img src="${attr(data.totp.qr_code)}" alt="Authentication QR code"></div>
      <label class="field"><span>Authentication code</span><input id="settingsMfaCode" inputmode="numeric" autocomplete="one-time-code"></label>`,
      `<button class="button ghost" id="settingsMfaCancel" type="button">Cancel</button><button class="button primary" id="settingsMfaVerify" type="button">Verify</button>`,"small");
    byId("settingsMfaCancel").onclick=async()=>{await state.client.auth.mfa.unenroll({factorId:data.id}).catch(()=>{});closeModal()};
    byId("settingsMfaVerify").onclick=async()=>{
      const button=byId("settingsMfaVerify");button.disabled=true;
      const {error}=await state.client.auth.mfa.challengeAndVerify({factorId:data.id,code:byId("settingsMfaCode").value.trim()});
      if(error){toast("Code not verified",friendlyError(error),"error");button.disabled=false}
      else{closeModal();toast("Authenticator verified");state.session=(await state.client.auth.getSession()).data.session}
    };
  }
  async function createManualBackup() {
    const button=byId("backupCreate");button.disabled=true;setSync("pending","Backing up");
    try{
      const snapshot=await rpc("export_backup_snapshot"),json=JSON.stringify(snapshot),blob=new Blob([json],{type:"application/json"});
      const checksum=await sha256(blob),filename=`nis-backup-${new Date().toISOString().replace(/[:.]/g,"-")}.json`;
      const path=`manual/${filename}`;
      const {error}=await state.client.storage.from(CONFIG.backupBucket).upload(path,blob,{contentType:"application/json",upsert:false});
      if(error)throw error;
      await rpc("record_backup_export",{target_storage_path:path,target_checksum:checksum,target_row_counts:{
        students:snapshot.students?.length||0,reports:snapshot.student_reports?.length||0,results:snapshot.subject_results?.length||0
      }});
      downloadBlob(filename,blob);toast("Backup completed",filename);setSync("online","Synced");
    }catch(error){toast("Backup unsuccessful",friendlyError(error),"error");setSync("pending","Retry required")}
    finally{button.disabled=false}
  }
  async function queueIncompleteNotifications() {
    const term=activeTerm();if(!term)return;
    const count=await run(()=>rpc("queue_incomplete_report_notifications",{target_term_id:term.id}),{success:"Notifications queued"});
    toast("Scheduled operation completed",`${number(count)} notifications queued`);
  }

  async function showVerification(token) {
    showOnly("verifyView");
    const root=byId("verifyView");root.innerHTML=`<div class="verify-card"><div class="empty">Verifying report</div></div>`;
    try{
      if(!isConfigured()||!window.supabase?.createClient)throw new Error("Verification service unavailable");
      if(!state.client)state.client=window.supabase.createClient(CONFIG.supabaseUrl,CONFIG.supabaseAnonKey,{auth:{persistSession:false}});
      const data=await rpc("verify_report",{token});
      root.innerHTML=`<section class="verify-card">
        <div class="verify-head"><img src="${CONFIG.logoPath}" alt=""><div><h1>Nipe International School</h1><p>Report Card Verification</p></div></div>
        <div class="verify-state ${data.valid?"valid":"invalid"}">${data.valid?"Authentic published report":data.revoked?"Publication withdrawn":"Report not verified"}</div>
        ${data.report_number?`<div class="verify-result">
          ${verifyField("Report number",data.report_number)}${verifyField("Student",data.student_name)}
          ${verifyField("Admission number",data.admission_no)}${verifyField("Class",data.class_name)}
          ${verifyField("Academic year",data.academic_year)}${verifyField("Term",data.term_name)}
          ${verifyField("Average",`${number(data.average,1)}%`)}${verifyField("Published",isoDateTime(data.published_at))}
        </div>`:""}
      </section>`;
    }catch(error){root.innerHTML=`<section class="verify-card"><div class="verify-state invalid">Verification unavailable</div></section>`}
  }
  function verifyField(label,value){return `<div class="verify-field"><span>${esc(label)}</span><strong>${esc(value??"—")}</strong></div>`}

})();
