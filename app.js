const socket = io();
const $ = id => document.getElementById(id);

let token = localStorage.getItem("nexa_token");
let me = localStorage.getItem("nexa_user");
let meDisplay = localStorage.getItem("nexa_display") || me;

let current = null;       // current وتس chat {type,id,...}
let groups = [];
let channels = [];
let watsTab = "chats";
let pendingPostImage = null;
let pendingStoryImage = null;
let storiesByUser = {};

function escapeHtml(s){return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
function authHeaders(extra){return Object.assign({"Content-Type":"application/json","x-auth-token":token||""}, extra||{})}
async function api(path, opts){
  const r = await fetch(path, opts);
  const data = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error || "حصل خطأ");
  return data;
}

/* ===================== تسجيل الدخول ===================== */
function switchAuthTab(tab){
  $("tabLoginBtn").classList.toggle("active", tab==="login");
  $("tabRegisterBtn").classList.toggle("active", tab==="register");
  $("loginForm").classList.toggle("hidden", tab!=="login");
  $("registerForm").classList.toggle("hidden", tab!=="register");
  $("authMsg").textContent = "";
}

async function register(){
  const displayName = $("regDisplayName").value.trim();
  const username = $("regUsername").value.trim().toLowerCase().replace(/^@/,"");
  const password = $("regPassword").value;
  $("authMsg").textContent = "";
  try{
    const data = await api("/api/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({displayName,username,password})});
    saveSession(data);
    start();
  }catch(e){$("authMsg").textContent=e.message}
}

async function login(){
  const username = $("loginUsername").value.trim().toLowerCase().replace(/^@/,"");
  const password = $("loginPassword").value;
  $("authMsg").textContent = "";
  try{
    const data = await api("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username,password})});
    saveSession(data);
    start();
  }catch(e){$("authMsg").textContent=e.message}
}

function saveSession(data){
  token = data.token; me = data.username; meDisplay = data.displayName;
  localStorage.setItem("nexa_token", token);
  localStorage.setItem("nexa_user", me);
  localStorage.setItem("nexa_display", meDisplay);
}

function logout(){
  localStorage.removeItem("nexa_token");
  localStorage.removeItem("nexa_user");
  localStorage.removeItem("nexa_display");
  location.reload();
}

async function start(){
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("me").innerHTML = `@${escapeHtml(me)} <button onclick="logout()" style="color:var(--muted);margin-inline-start:8px;font-size:12px;text-decoration:underline">خروج</button>`;
  socket.emit("join", token);
  loadGroups();
  loadChannels();
  loadFeed();
  loadStories();
}

/* ===================== التبديل بين فيس وواتس ===================== */
function switchSection(section){
  $("switchFace").classList.toggle("active", section==="face");
  $("switchWats").classList.toggle("active", section==="wats");
  $("faceSection").classList.toggle("hidden", section!=="face");
  $("watsSection").classList.toggle("hidden", section!=="wats");
  if(section==="face"){ loadFeed(); loadStories(); }
}

/* ===================== فيس: صور ===================== */
function onPickImage(ev, kind){
  const file = ev.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    if(kind==="post"){
      pendingPostImage = reader.result;
      $("postPreviewImg").src = pendingPostImage;
      $("postPreview").classList.remove("hidden");
    }else{
      pendingStoryImage = reader.result;
      submitStory();
    }
  };
  reader.readAsDataURL(file);
}
function clearPostImage(){
  pendingPostImage = null;
  $("postImageInput").value = "";
  $("postPreview").classList.add("hidden");
}

/* ===================== فيس: منشورات ===================== */
async function submitPost(){
  const text = $("postText").value.trim();
  if(!text && !pendingPostImage) return;
  try{
    await api("/api/posts",{method:"POST",headers:authHeaders(),body:JSON.stringify({text,image:pendingPostImage})});
    $("postText").value = "";
    clearPostImage();
    loadFeed();
  }catch(e){alert(e.message)}
}

async function loadFeed(){
  const posts = await api("/api/posts",{headers:authHeaders()});
  const box = $("feed");
  if(!posts.length){ box.innerHTML = `<div class="empty-hint">لسه معملتش أي منشور... ابدأ دلوقتي 👆</div>`; return; }
  box.innerHTML = posts.map(postHtml).join("");
}

function postHtml(p){
  const initial = escapeHtml(p.display_name || p.username).slice(0,1).toUpperCase();
  const img = p.image_data ? `<img class="post-img" src="${p.image_data}">` : "";
  const delBtn = p.username===me ? `<button class="del-btn" onclick="deletePost(${p.id})">حذف</button>` : "";
  return `<div class="post">
    <div class="post-head">
      <div class="post-avatar">${initial}</div>
      <div><b>${escapeHtml(p.display_name)}</b><small>@${escapeHtml(p.username)} • ${new Date(p.created_at).toLocaleString("ar-EG")}</small></div>
    </div>
    ${p.text?`<div class="post-text">${escapeHtml(p.text)}</div>`:""}
    ${img}
    <div class="post-actions">
      <button class="like-btn ${p.likedByMe?"liked":""}" onclick="toggleLike(${p.id},this)">❤ <span>${p.likes}</span></button>
      ${delBtn}
    </div>
  </div>`;
}

async function toggleLike(id, btn){
  try{
    const data = await api(`/api/posts/${id}/like`,{method:"POST",headers:authHeaders()});
    btn.classList.toggle("liked", data.likedByMe);
    btn.querySelector("span").textContent = data.likes;
  }catch(e){alert(e.message)}
}

async function deletePost(id){
  if(!confirm("متأكد إنك عايز تحذف المنشور؟")) return;
  try{ await api(`/api/posts/${id}`,{method:"DELETE",headers:authHeaders()}); loadFeed(); }
  catch(e){alert(e.message)}
}

/* ===================== فيس: حالات ===================== */
async function submitStory(){
  try{
    await api("/api/stories",{method:"POST",headers:authHeaders(),body:JSON.stringify({text:"",image:pendingStoryImage})});
    pendingStoryImage = null;
    $("storyImageInput").value = "";
    loadStories();
  }catch(e){alert(e.message)}
}

async function loadStories(){
  const stories = await api("/api/stories",{headers:authHeaders()});
  storiesByUser = {};
  for(const s of stories){
    if(!storiesByUser[s.username]) storiesByUser[s.username] = {display_name:s.display_name, items:[]};
    storiesByUser[s.username].items.push(s);
  }
  const box = $("storiesBar");
  const users = Object.keys(storiesByUser);
  const mine = `<div class="story-circle" onclick="document.getElementById('storyImageInput').click()">
      <div class="story-ring"><div class="inner">+</div></div><small>حالتك</small></div>`;
  box.innerHTML = mine + users.map(u=>{
    const info = storiesByUser[u];
    const thumb = info.items[0].image_data ? `<img src="${info.items[0].image_data}">` : escapeHtml(info.display_name).slice(0,1).toUpperCase();
    return `<div class="story-circle" onclick="openStory('${u}')">
      <div class="story-ring"><div class="inner">${thumb}</div></div><small>${escapeHtml(info.display_name)}</small></div>`;
  }).join("");
}

let storyIndex = 0;
function openStory(username){
  const info = storiesByUser[username];
  if(!info) return;
  storyIndex = 0;
  window._storyUser = username;
  renderStoryFrame();
  $("storyViewer").classList.remove("hidden");
}
function renderStoryFrame(){
  const info = storiesByUser[window._storyUser];
  const s = info.items[storyIndex];
  $("storyHead").textContent = `${info.display_name} • ${new Date(s.created_at).toLocaleTimeString("ar-EG")}`;
  $("storyBody").innerHTML = s.image_data ? `<img src="${s.image_data}">` : `<div style="font-size:20px">${escapeHtml(s.text)}</div>`;
}
function closeStory(ev){
  if(ev.target.id==="storyViewer" || ev.target.closest(".story-head")){
    $("storyViewer").classList.add("hidden");
  }
}

/* ===================== واتس: بحث و خاص ===================== */
async function searchUsers(){
  const q = $("search").value.trim();
  const box = $("results");
  if(!q){box.innerHTML="";return}
  const data = await api("/api/search?q="+encodeURIComponent(q));
  box.innerHTML = data.filter(u=>u.username!==me).map(u =>
    `<div class="result" onclick="openPrivate('${u.username}','${escapeHtml(u.display_name)}')"><b>@${escapeHtml(u.username)}</b><small>${escapeHtml(u.display_name)}</small></div>`
  ).join("");
}

async function openPrivate(username, displayName){
  current = {type:"private", id:[me,username].sort().join(":"), username};
  $("results").innerHTML=""; $("search").value="";
  $("chatHeader").innerHTML=`<div><b>${escapeHtml(displayName)}</b><small>@${escapeHtml(username)} • محادثة خاصة</small></div>`;
  enableComposer();
  setWatsTab("chats");
  const msgs = await api("/api/messages/private/"+encodeURIComponent(current.id));
  renderMessages(msgs);
}

/* ===================== واتس: تابات ===================== */
function setWatsTab(tab){
  watsTab = tab;
  document.querySelectorAll(".wt").forEach(b=>b.classList.toggle("active", b.dataset.wt===tab));
  $("watsChats").classList.toggle("hidden", tab!=="chats");
  $("watsGroups").classList.toggle("hidden", tab!=="groups");
  $("watsChannels").classList.toggle("hidden", tab!=="channels");
  if(tab==="chats") renderRecentList();
}

function renderRecentList(){
  $("watsChats").innerHTML = current
    ? `<div class="chat-item active">آخر محادثة مفتوحة: ${current.type==="private"?"@"+escapeHtml(current.username):escapeHtml(current.name||"")}</div>`
    : `<div class="empty-hint">ابحث بالأعلى وابدأ محادثة خاصة</div>`;
}

/* ===================== واتس: مجموعات ===================== */
async function loadGroups(){
  groups = await api("/api/groups/"+encodeURIComponent(me));
  renderGroups();
}
function renderGroups(){
  $("groupsList").innerHTML = groups.map(g =>
    `<div class="chat-item ${current?.type==="group"&&current.id==g.id?"active":""}" onclick="openGroup(${g.id},'${escapeHtml(g.name)}')">👥 ${escapeHtml(g.name)}<small>مجموعة</small></div>`
  ).join("") || `<div class="empty-hint">مفيش مجموعات لسه</div>`;
}
async function openGroup(id,name){
  current={type:"group",id,name};
  $("chatHeader").innerHTML=`<div><b>${escapeHtml(name)}</b><small>دردشة جماعية</small></div>`;
  enableComposer(); renderGroups();
  const msgs = await api("/api/messages/group/"+id);
  renderMessages(msgs);
}
async function createGroup(){
  const name=prompt("اسم المجموعة:");
  if(!name)return;
  const raw=prompt("يوزرات الأعضاء مفصولة بفواصل (اختياري):")||"";
  const members=raw.split(",").map(x=>x.trim().replace(/^@/,"")).filter(Boolean);
  try{
    const data = await api("/api/groups",{method:"POST",headers:authHeaders(),body:JSON.stringify({name,members})});
    await loadGroups();
    openGroup(data.id,data.name);
  }catch(e){alert(e.message)}
}

/* ===================== واتس: قنوات ===================== */
async function loadChannels(){
  channels = await api("/api/channels/"+encodeURIComponent(me));
  renderChannels();
  loadDiscoverChannels();
}
function renderChannels(){
  $("channelsList").innerHTML = channels.map(c =>
    `<div class="chat-item ${current?.type==="channel"&&current.id==c.id?"active":""}" onclick="openChannel(${c.id},'${escapeHtml(c.name)}','${c.role}')">📢 ${escapeHtml(c.name)}<small>${c.role==="owner"?"أنت المالك":"مشترك"}</small></div>`
  ).join("") || `<div class="empty-hint">لسه معملتش أو اشتركتش في قناة</div>`;
}
async function loadDiscoverChannels(){
  const all = await api("/api/channels-discover");
  const mine = new Set(channels.map(c=>c.id));
  const others = all.filter(c=>!mine.has(c.id));
  $("channelsDiscover").innerHTML = others.map(c =>
    `<div class="chat-item">📢 ${escapeHtml(c.name)}<small>بواسطة @${escapeHtml(c.owner)}</small><button class="join-btn" onclick="event.stopPropagation();joinChannel(${c.id})">اشترك</button></div>`
  ).join("") || `<div class="empty-hint">مفيش قنوات تانية دلوقتي</div>`;
}
async function joinChannel(id){
  try{ await api(`/api/channels/${id}/join`,{method:"POST",headers:authHeaders()}); await loadChannels(); }
  catch(e){alert(e.message)}
}
async function createChannel(){
  const name = prompt("اسم القناة:");
  if(!name) return;
  try{
    const data = await api("/api/channels",{method:"POST",headers:authHeaders(),body:JSON.stringify({name})});
    await loadChannels();
    openChannel(data.id, data.name, "owner");
  }catch(e){alert(e.message)}
}
async function openChannel(id,name,role){
  current={type:"channel",id,name};
  $("chatHeader").innerHTML=`<div><b>📢 ${escapeHtml(name)}</b><small>${role==="owner"?"النشر متاح لك فقط لأنك المالك":"قناة • النشر لصاحبها فقط"}</small></div>`;
  enableComposer(); renderChannels();
  const msgs = await api("/api/messages/channel/"+id);
  renderMessages(msgs);
}

/* ===================== الرسائل ===================== */
function enableComposer(){
  $("message").disabled=false;
  $("sendForm").querySelector("button").disabled=false;
  $("message").focus();
}
function renderMessages(msgs){
  const box=$("messages");
  box.innerHTML=msgs.map(m=>messageHtml(m)).join("");
  box.scrollTop=box.scrollHeight;
}
function messageHtml(m){
  return `<div class="msg ${m.sender===me?"mine":""}"><div class="sender">@${escapeHtml(m.sender)}</div><div>${escapeHtml(m.text)}</div><div class="time">${new Date(m.created_at).toLocaleString("ar-EG")}</div></div>`;
}

$("sendForm").addEventListener("submit",e=>{
  e.preventDefault();
  const text=$("message").value.trim();
  if(!text||!current)return;
  if(current.type==="private") socket.emit("private:send",{to:current.username,text});
  else if(current.type==="group") socket.emit("group:send",{groupId:current.id,text});
  else if(current.type==="channel") socket.emit("channel:send",{channelId:current.id,text});
  $("message").value="";
});

socket.on("private:message",m=>{
  if(current?.type==="private" && current.id===[me,m.to].sort().join(":")){
    $("messages").insertAdjacentHTML("beforeend",messageHtml(m));
    $("messages").scrollTop=$("messages").scrollHeight;
  }
});
socket.on("group:message",m=>{
  if(current?.type==="group" && Number(current.id)===Number(m.groupId)){
    $("messages").insertAdjacentHTML("beforeend",messageHtml(m));
    $("messages").scrollTop=$("messages").scrollHeight;
  }
});
socket.on("channel:message",m=>{
  if(current?.type==="channel" && Number(current.id)===Number(m.channelId)){
    $("messages").insertAdjacentHTML("beforeend",messageHtml(m));
    $("messages").scrollTop=$("messages").scrollHeight;
  }
});
socket.on("errorMessage",msg=>alert(msg));

/* ===================== بدء التشغيل ===================== */
if(me && token) start();
