const viewMeta = {
  catalog: ["WPPMEDIA MD SkillHub", "浏览、安装和管理团队发布的 Agent Skill。"],
  submit: ["上传 / 导入", "团队成员上传 zip 或粘贴 GitHub 链接导入 Skill。"],
  review: ["审核发布", "管理员批准、驳回、发布上线并按需同步 GitHub。"],
  users: ["用户管理", "创建团队成员和管理员账号。"],
};

let session = null;
let skills = [];
let versionsBySkill = new Map();
let users = [];
let health = { githubConfigured: false, githubSyncConfigured: false, publishRepo: null, publishBranch: "main" };
let selectedVersion = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function toast(message) {
  const node = document.getElementById("toast");
  node.textContent = message;
  node.classList.add("show");
  window.setTimeout(() => node.classList.remove("show"), 2200);
}

async function api(route, options = {}) {
  const response = await fetch(route, {
    credentials: "include",
    ...options,
    headers: options.body instanceof FormData ? options.headers : {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error?.code || "request_failed";
    throw new Error(message);
  }
  return payload.data;
}

function badge(value) {
  return `<span class="badge ${escapeHtml(value)}">${escapeHtml(value || "-")}</span>`;
}

function tagPill(value) {
  return `<span class="platform-tag">${escapeHtml(value)}</span>`;
}

function renderTags(tags, fallback = "未分类") {
  const values = Array.isArray(tags) && tags.length ? tags : [fallback];
  return values.map(tagPill).join("");
}

function absoluteClientUrl(value) {
  if (!value) return "";
  return new URL(value, window.location.origin).href;
}

function publicDownloadHref(version) {
  return absoluteClientUrl(version?.publicDownloadPath || version?.publicDownloadUrl || version?.downloadUrl);
}

function installScriptHref(version) {
  return absoluteClientUrl(version?.installScriptPath || version?.installScriptUrl);
}

function authenticatedDownloadHref(version) {
  return absoluteClientUrl(version?.downloadUrl || version?.authenticatedDownloadUrl);
}

function installCommand(version) {
  const script = installScriptHref(version);
  return script ? `curl -fsSL ${script} | sh` : version?.installCommand || "";
}

function versionForSkill(skill) {
  const versions = versionsBySkill.get(skill.id) || [];
  if (!versions.length) return null;
  return versions[0];
}

function currentSkillFilter() {
  return document.getElementById("skillSearch")?.value?.toLowerCase().trim() || "";
}

function filteredSkills() {
  const query = currentSkillFilter();
  return skills.filter((skill) => {
    const version = versionForSkill(skill);
    return `${skill.name} ${skill.slug} ${skill.ownerTeam} ${(skill.tags || []).join(" ")} ${version?.status || ""} ${version?.sourceType || ""}`.toLowerCase().includes(query);
  });
}

function skillInitials(skill) {
  return String(skill?.name || skill?.slug || "MD")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function allVersions() {
  return [...versionsBySkill.values()].flat();
}

function canAdmin() {
  return session?.role === "admin";
}

function setView(view) {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach((node) => {
    node.classList.toggle("active", node.id === `view-${view}`);
  });
  document.getElementById("viewTitle").textContent = viewMeta[view][0];
  document.getElementById("viewSubtitle").textContent = viewMeta[view][1];
}

function renderShell() {
  document.getElementById("loginScreen").classList.toggle("hidden", Boolean(session));
  document.getElementById("appShell").classList.toggle("hidden", !session);
  if (!session) return;
  document.getElementById("sessionLabel").textContent = `${session.name} · ${session.role}`;
  document.querySelectorAll(".admin-only").forEach((node) => {
    node.classList.toggle("hidden", !canAdmin());
  });
  const githubStatus = document.getElementById("githubStatus");
  githubStatus.textContent = health.githubSyncConfigured
    ? `GitHub: ${health.publishRepo}`
    : health.githubConfigured
      ? "GitHub 已配置，未设发布仓库"
      : "GitHub App 未配置，公开 repo 可导入";
  githubStatus.classList.toggle("online", Boolean(health.githubSyncConfigured));
  githubStatus.classList.toggle("offline", !health.githubSyncConfigured);
  document.querySelectorAll('input[name="ownerTeam"]').forEach((input) => {
    if (!input.value) input.value = session.team || "default";
    input.readOnly = !canAdmin();
  });
}

function renderMetrics() {
  const versions = allVersions();
  const published = versions.filter((item) => item.status === "published").length;
  const review = versions.filter((item) => item.status === "review").length;
  const approved = versions.filter((item) => item.status === "approved").length;
  const failedSync = versions.filter((item) => item.syncStatus === "failed").length;
  const metrics = [
    ["Skill", skills.length, `${published} published`],
    ["待审核", review, "review queue"],
    ["待发布", approved, "approved"],
    ["同步失败", failedSync, health.publishRepo || "publish repo"],
  ];
  document.getElementById("metrics").innerHTML = metrics.map(([label, value, detail]) => `
    <div class="metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(detail)}</small>
    </div>
  `).join("");
}

function renderSkillCards() {
  const target = document.getElementById("skillCards");
  if (!target) return;
  const filtered = filteredSkills();
  target.innerHTML = filtered.length ? filtered.map((skill) => {
    const version = versionForSkill(skill);
    const isPublished = version?.status === "published";
    const description = skill.description || version?.manifest?.description || "等待补充 Skill 描述。";
    const downloadHref = isPublished ? publicDownloadHref(version) : "";
    const permissions = version?.permissions?.length ? version.permissions.slice(0, 3).join(", ") : "no permissions";
    return `
      <article class="skill-card">
        <div class="skill-card-top">
          <div class="skill-icon">${escapeHtml(skillInitials(skill))}</div>
          <div class="skill-card-meta">
            <strong>${escapeHtml(skill.name)}</strong>
            <span>${escapeHtml(skill.slug)}</span>
          </div>
        </div>
        <p>${escapeHtml(description)}</p>
        <div class="skill-card-tags platform-tags">
          ${renderTags(skill.tags)}
        </div>
        <div class="skill-card-tags">
          ${badge(version?.status)}
          ${badge(version?.risk)}
          ${badge(version?.sourceType)}
        </div>
        <div class="skill-card-stats">
          <span>Team ${escapeHtml(skill.ownerTeam || "-")}</span>
          <span>${escapeHtml(version?.version || "-")}</span>
          <span>${escapeHtml(version?.fileManifest?.length || 0)} files</span>
          <span>${escapeHtml(permissions)}</span>
        </div>
        <div class="skill-card-actions">
          ${isPublished ? `<button class="install-button" data-action="copy-install" data-version-id="${version.id}" type="button">复制安装命令</button>` : `<span class="install-button disabled">待发布</span>`}
          ${isPublished ? `<a class="mini-link" href="${escapeHtml(installScriptHref(version))}" target="_blank" rel="noreferrer">脚本链接</a>` : ""}
          ${isPublished ? `<a class="mini-link" href="${escapeHtml(downloadHref)}">下载 zip</a>` : ""}
          <button class="mini-button" data-action="detail" data-skill-id="${skill.id}" data-version-id="${version?.id || ""}" type="button">详情</button>
        </div>
      </article>
    `;
  }).join("") : `<div class="empty-card">暂无匹配 Skill</div>`;
}

function renderSkillRows() {
  const filtered = filteredSkills();
  document.getElementById("skillRows").innerHTML = filtered.length ? filtered.map((skill) => {
    const version = versionForSkill(skill);
    return `
      <tr>
        <td>
          <div class="row-title">
            <strong>${escapeHtml(skill.name)}</strong>
            <span>${escapeHtml(skill.slug)}</span>
          </div>
        </td>
        <td>${escapeHtml(version?.version || "-")}</td>
        <td>${escapeHtml(skill.ownerTeam || "-")}</td>
        <td><div class="platform-tags compact">${renderTags(skill.tags)}</div></td>
        <td>${badge(version?.status)}</td>
        <td>${badge(version?.risk)}</td>
        <td>${escapeHtml(version?.sourceType || "-")}<br><span class="muted">${escapeHtml(version?.sourceRepo || version?.sourcePath || "-")}</span></td>
        <td>${escapeHtml(version?.publishCommitSha ? version.publishCommitSha.slice(0, 8) : version?.syncStatus || "-")}</td>
        <td>
          <div class="actions">
            <button class="mini-button" data-action="detail" data-skill-id="${skill.id}" data-version-id="${version?.id || ""}" type="button">详情</button>
            ${version?.status === "published" ? `<a class="mini-link" href="${escapeHtml(publicDownloadHref(version))}">下载</a>` : ""}
          </div>
        </td>
      </tr>
    `;
  }).join("") : `<tr><td colspan="9" class="muted">暂无 Skill</td></tr>`;
}

function renderMySubmissions() {
  const mine = allVersions().filter((version) => canAdmin() || version.createdBy === session.id);
  document.getElementById("mySubmissionRows").innerHTML = mine.length ? mine.map((version) => {
    const skill = skills.find((item) => item.id === version.skillId);
    return `
      <tr>
        <td>${escapeHtml(skill?.name || version.skillId)}<br><span class="muted">${escapeHtml(skill?.slug || "")}</span></td>
        <td>${escapeHtml(version.version)}</td>
        <td>${badge(version.status)}</td>
        <td>${badge(version.risk)}</td>
        <td>${escapeHtml(version.sourceType)}<br><span class="muted">${escapeHtml(version.sourceRepo || version.sourcePath || "-")}</span></td>
        <td>
          <div class="actions">
            ${version.status === "draft" ? `<button class="mini-button" data-action="submit-review" data-version-id="${version.id}" type="button">提交审核</button>` : ""}
            <button class="mini-button" data-action="detail" data-skill-id="${version.skillId}" data-version-id="${version.id}" type="button">详情</button>
          </div>
        </td>
      </tr>
    `;
  }).join("") : `<tr><td colspan="6" class="muted">暂无提交</td></tr>`;
}

function renderReviewList() {
  const queue = allVersions().filter((version) => ["review", "approved", "rejected", "published"].includes(version.status));
  document.getElementById("reviewList").innerHTML = queue.length ? queue.map((version) => {
    const skill = skills.find((item) => item.id === version.skillId);
    return `
      <article class="review-item">
        <div>
          <strong>${escapeHtml(skill?.name || version.skillId)} @ ${escapeHtml(version.version)}</strong>
          <p>${escapeHtml(version.sourceType)} · ${escapeHtml(version.sourceRepo || version.sourcePath || "-")} · ${version.fileManifest.length} files</p>
          <p>${version.permissions.map(escapeHtml).join(", ") || "no permissions"} · ${escapeHtml(version.contentHash.slice(0, 12))}</p>
          ${version.syncError ? `<p class="danger-text">${escapeHtml(version.syncError)}</p>` : ""}
        </div>
        <div class="review-actions">
          ${badge(version.status)}
          ${badge(version.risk)}
          <button class="mini-button" data-action="detail" data-skill-id="${version.skillId}" data-version-id="${version.id}" type="button">详情</button>
          ${version.status === "review" ? `<button class="mini-button" data-action="approve" data-version-id="${version.id}" type="button">批准</button>` : ""}
          ${version.status === "review" ? `<button class="mini-button" data-action="reject" data-version-id="${version.id}" type="button">驳回</button>` : ""}
          ${version.status === "approved" ? `<button class="mini-button" data-action="publish" data-version-id="${version.id}" type="button">发布上线</button>` : ""}
          ${version.status === "published" && health.githubSyncConfigured && version.syncStatus !== "synced" ? `<button class="mini-button" data-action="sync-github" data-version-id="${version.id}" type="button">同步 GitHub</button>` : ""}
          ${version.status === "published" ? `<button class="mini-button" data-action="archive" data-version-id="${version.id}" type="button">下架</button>` : ""}
        </div>
      </article>
    `;
  }).join("") : `<p class="muted">暂无审核项</p>`;
}

function renderUsers() {
  const target = document.getElementById("userRows");
  if (!target) return;
  target.innerHTML = users.length ? users.map((user) => `
    <tr>
      <td>${escapeHtml(user.name)}<br><span class="muted">${escapeHtml(user.email)}${user.rejectionReason ? ` · ${escapeHtml(user.rejectionReason)}` : ""}</span></td>
      <td>${escapeHtml(user.team)}</td>
      <td>${badge(user.role)}</td>
      <td>${badge(user.status)}</td>
      <td>${formatDate(user.createdAt)}</td>
      <td>
        <div class="actions">
          ${user.status === "pending" ? `<button class="mini-button" data-action="approve-user" data-user-id="${user.id}" type="button">批准</button>` : ""}
          ${user.status === "pending" ? `<button class="mini-button" data-action="reject-user" data-user-id="${user.id}" type="button">驳回</button>` : ""}
        </div>
      </td>
    </tr>
  `).join("") : `<tr><td colspan="6" class="muted">暂无用户</td></tr>`;
}

function renderVersionDetail() {
  const target = document.getElementById("versionDetail");
  if (!selectedVersion) {
    target.className = "detail-empty";
    target.innerHTML = "选择一条 Skill 查看详情。";
    return;
  }
  target.className = "detail-grid";
  const skill = skills.find((item) => item.id === selectedVersion.skillId);
  const isPublished = selectedVersion.status === "published";
  const install = isPublished ? installCommand(selectedVersion) : "发布上线后显示在线拉取命令";
  const zipHref = isPublished ? publicDownloadHref(selectedVersion) : authenticatedDownloadHref(selectedVersion);
  const scriptHref = isPublished ? installScriptHref(selectedVersion) : "";
  target.innerHTML = `
    <div>
      <h3>${escapeHtml(skill?.name || selectedVersion.skillId)} @ ${escapeHtml(selectedVersion.version)}</h3>
      <p class="muted">${escapeHtml(skill?.description || "")}</p>
      <div class="detail-badges">${badge(selectedVersion.status)} ${badge(selectedVersion.risk)} ${badge(selectedVersion.sourceType)}</div>
    </div>
    <div class="detail-section">
      <strong>Team / 标签</strong>
      <p>${escapeHtml(skill?.ownerTeam || "-")}</p>
      <div class="platform-tags">${renderTags(skill?.tags)}</div>
    </div>
    <div class="detail-section">
      <strong>Agent 在线拉取</strong>
      <code>${escapeHtml(install)}</code>
      <div class="detail-actions">
        ${isPublished ? `<button class="mini-button" data-action="copy-install" data-version-id="${selectedVersion.id}" type="button">复制命令</button>` : ""}
        ${isPublished ? `<a class="mini-link" href="${escapeHtml(scriptHref)}" target="_blank" rel="noreferrer">脚本链接</a>` : ""}
        <a class="mini-link" href="${escapeHtml(zipHref)}">${isPublished ? "下载 zip" : "管理员下载 zip"}</a>
      </div>
    </div>
    <div class="detail-section">
      <strong>来源</strong>
      <p>${escapeHtml(selectedVersion.sourceRepo || "-")}</p>
      <p>${escapeHtml(selectedVersion.sourcePath || "-")} @ ${escapeHtml(selectedVersion.sourceRef || "-")}</p>
      <p>${escapeHtml(selectedVersion.sourceCommitSha || "-")}</p>
    </div>
    <div class="detail-section">
      <strong>发布</strong>
      <p>${escapeHtml(selectedVersion.publishRepo || health.publishRepo || "-")} / ${escapeHtml(selectedVersion.publishBranch || health.publishBranch || "-")}</p>
      <p>${escapeHtml(selectedVersion.publishCommitSha || selectedVersion.syncStatus || "-")}</p>
    </div>
    <div class="detail-section">
      <strong>权限</strong>
      <p>${selectedVersion.permissions.map(escapeHtml).join(", ") || "none"}</p>
    </div>
    <div class="detail-section">
      <strong>扫描</strong>
      <p>${selectedVersion.scanReport.fileCount || 0} files · ${selectedVersion.scanReport.totalBytes || 0} bytes</p>
      <p>${(selectedVersion.scanReport.warnings || []).map(escapeHtml).join(" / ") || "no warnings"}</p>
    </div>
    <div class="detail-section full">
      <strong>文件清单</strong>
      <div class="file-list">
        ${selectedVersion.fileManifest.map((file) => `<span>${escapeHtml(file.path)} · ${file.size} bytes</span>`).join("")}
      </div>
    </div>
  `;
}

function render() {
  renderShell();
  if (!session) return;
  renderMetrics();
  renderSkillCards();
  renderSkillRows();
  renderMySubmissions();
  renderReviewList();
  renderUsers();
  renderVersionDetail();
}

async function loadHealth() {
  health = await api("/api/health");
}

async function loadSkills() {
  skills = await api("/api/skills");
  versionsBySkill = new Map();
  await Promise.all(skills.map(async (skill) => {
    const versions = await api(`/api/skills/${skill.id}/versions`);
    versionsBySkill.set(skill.id, versions);
  }));
}

async function loadUsers() {
  if (!canAdmin()) {
    users = [];
    return;
  }
  users = await api("/api/users");
}

async function refreshAll() {
  await loadHealth();
  if (session) {
    await loadSkills();
    await loadUsers();
  }
  render();
}

async function bootstrap() {
  await loadHealth().catch(() => undefined);
  try {
    session = await api("/api/me");
    await refreshAll();
  } catch {
    session = null;
    render();
  }
}

function formDataObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function handleLogin(event) {
  event.preventDefault();
  const data = formDataObject(event.currentTarget);
  try {
    session = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(data),
    });
    await refreshAll();
    toast("已登录");
  } catch (error) {
    toast(`登录失败: ${error.message}`);
  }
}

async function handleRegister(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(formDataObject(form)),
    });
    form.reset();
    form.elements.team.value = "default";
    toast("注册申请已提交，等待管理员批准");
  } catch (error) {
    toast(`注册失败: ${error.message}`);
  }
}

async function handleUpload(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = new FormData(form);
  try {
    await api("/api/skills/uploads", {
      method: "POST",
      body: payload,
    });
    form.reset();
    resetOwnerTeamFields();
    await refreshAll();
    toast("上传完成，已生成草稿");
  } catch (error) {
    toast(`上传失败: ${error.message}`);
  }
}

async function handleGithubImport(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = formDataObject(form);
  try {
    await api("/api/skills/imports/github", {
      method: "POST",
      body: JSON.stringify(data),
    });
    form.reset();
    resetOwnerTeamFields();
    await refreshAll();
    toast("GitHub 导入完成，已生成草稿");
  } catch (error) {
    toast(`GitHub 导入失败: ${error.message}`);
  }
}

async function handleCreateUser(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api("/api/users", {
      method: "POST",
      body: JSON.stringify(formDataObject(form)),
    });
    form.reset();
    form.elements.team.value = "default";
    resetOwnerTeamFields();
    await refreshAll();
    toast("用户已创建");
  } catch (error) {
    toast(`创建失败: ${error.message}`);
  }
}

async function postAction(route, body = {}) {
  await api(route, {
    method: "POST",
    body: JSON.stringify(body),
  });
  await refreshAll();
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

async function handleAction(event) {
  const trigger = event.target.closest("[data-action]");
  if (!trigger) return;
  const action = trigger.dataset.action;
  const versionId = trigger.dataset.versionId;
  const userId = trigger.dataset.userId;

  try {
    if (action === "detail") {
      const versions = versionsBySkill.get(trigger.dataset.skillId) || [];
      selectedVersion = versions.find((item) => item.id === versionId) || versions[0] || null;
      renderVersionDetail();
      document.getElementById("detailPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (action === "copy-install") {
      const version = allVersions().find((item) => item.id === versionId) || selectedVersion;
      if (!version || version.status !== "published") {
        toast("发布上线后才能复制安装命令");
        return;
      }
      await copyText(installCommand(version));
      toast("安装命令已复制");
      return;
    }
    if (action === "submit-review") {
      await postAction(`/api/skill-versions/${versionId}/submit-review`);
      toast("已提交审核");
      return;
    }
    if (action === "approve") {
      await postAction(`/api/skill-versions/${versionId}/approve`);
      toast("已批准");
      return;
    }
    if (action === "reject") {
      const reason = window.prompt("请输入驳回原因");
      if (!reason) return;
      await postAction(`/api/skill-versions/${versionId}/reject`, { reason });
      toast("已驳回");
      return;
    }
    if (action === "publish") {
      await postAction(`/api/skill-versions/${versionId}/publish`);
      toast("已发布上线");
      return;
    }
    if (action === "sync-github") {
      await postAction(`/api/skill-versions/${versionId}/sync-github`);
      toast("已同步 GitHub");
      return;
    }
    if (action === "archive") {
      await postAction(`/api/skill-versions/${versionId}/archive`);
      toast("已下架");
      return;
    }
    if (action === "approve-user") {
      await postAction(`/api/users/${userId}/approve`);
      toast("用户已批准");
      return;
    }
    if (action === "reject-user") {
      const reason = window.prompt("请输入驳回原因");
      if (!reason) return;
      await postAction(`/api/users/${userId}/reject`, { reason });
      toast("用户已驳回");
    }
  } catch (error) {
    toast(`操作失败: ${error.message}`);
  }
}

function bindEvents() {
  document.getElementById("loginForm").addEventListener("submit", handleLogin);
  document.getElementById("registerForm").addEventListener("submit", handleRegister);
  document.getElementById("uploadForm").addEventListener("submit", handleUpload);
  document.getElementById("githubImportForm").addEventListener("submit", handleGithubImport);
  document.getElementById("userForm").addEventListener("submit", handleCreateUser);
  document.getElementById("skillSearch").addEventListener("input", () => {
    renderSkillCards();
    renderSkillRows();
  });
  document.querySelector(".search-box .primary-button").addEventListener("click", () => {
    renderSkillCards();
    renderSkillRows();
  });
  document.querySelectorAll("[data-search-chip]").forEach((button) => {
    button.addEventListener("click", () => {
      document.getElementById("skillSearch").value = button.dataset.searchChip;
      renderSkillCards();
      renderSkillRows();
    });
  });
  document.getElementById("focusSubmit").addEventListener("click", () => setView("submit"));
  document.getElementById("refreshData").addEventListener("click", () => refreshAll().then(() => toast("已刷新")));
  document.getElementById("logoutButton").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => undefined);
    session = null;
    render();
  });
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });
  document.body.addEventListener("click", handleAction);
}

function resetOwnerTeamFields() {
  document.querySelectorAll('input[name="ownerTeam"]').forEach((input) => {
    input.value = session?.team || "default";
    input.readOnly = !canAdmin();
  });
}

bindEvents();
bootstrap();
