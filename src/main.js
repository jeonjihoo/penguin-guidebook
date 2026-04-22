import { invoke } from '@tauri-apps/api/core';
import {
  fetchAdminProfiles,
  fetchPresenceRows,
  fetchSharedPayload,
  getCurrentRemoteSession,
  isSupabaseConfigured,
  removePresenceRow,
  saveSharedPayload,
  signInAdmin,
  signOutAdminRemote,
  updateAdminProfile,
  updateOwnAdminPassword,
  uploadGuidebookMedia,
  upsertPresenceRow,
} from './supabase.js';

const APP_VERSION = '2.0.0';
const STORAGE_KEY = 'ide_online_easy_guide_book_v20_data';
const SESSION_KEY = 'ide_online_easy_guide_book_v20_session';
const THEME_KEY = 'ide_online_easy_guide_book_v20_theme';
const THEMES = [
  { value: 'white', label: '화이트' },
  { value: 'dark', label: '다크' },
  { value: 'gray', label: '그레이' },
  { value: 'mint', label: '민트' },
  { value: 'lavender', label: '라벤더' },
  { value: 'peach', label: '피치' },
  { value: 'aurora', label: '오로라' },
];

const ACTIVE_TTL_MS = 2 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const REMOTE_SYNC_MS = 5 * 1000;
const ADMIN_LOCK_KEY = 'ide_online_easy_guide_book_v20_admin_lock';
const ADMIN_LOCK_FAIL_LIMIT = 5;
const ADMIN_LOCK_MS = 60 * 1000;
const LOCAL_APP_MODE_LABEL = '로컬 파일럿 운영';
const REMOTE_APP_MODE_LABEL = 'Supabase 다중 사용자 운영';
const DEFAULT_SUPER_ADMIN = Object.freeze({ username: 'jeonjihoo', password: 'caption1216!' });

const state = {
  data: null,
  session: {
    userNickname: '',
    currentIp: '127.0.0.1',
    adminId: null,
    deviceId: '',
    rememberAdminUsername: false,
    rememberedAdminUsername: '',
  },
  ui: {
    currentView: 'launcher',
    history: ['launcher'],
    returnAfterNickname: 'launcher',
    currentCategoryId: null,
    currentPostId: null,
    currentNoticeId: null,
    searchResults: [],
    searchQuery: '',
    activeAdminTab: 'overview',
    lastRenderedAdminTab: 'overview',
    editingPostId: null,
    editingNoticeId: null,
    selectedAdminId: null,
    previewingDraft: false,
    mediaInsertType: 'image',
  },
  theme: 'white',
  postDraft: null,
  noticeDraft: null,
  presenceUsers: [],
  remote: {
    enabled: false,
    initialized: false,
    syncTimerId: null,
    presenceSyncBusy: false,
    dataSyncBusy: false,
    lastError: '',
    lastSyncedAt: '',
    lastPresenceAt: '',
    pendingSnapshot: null,
    presencePollBusy: false,
  },
};

const els = {};

function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

function getOrCreateDeviceId() {
  const key = 'ide_online_easy_guide_book_v20_device';
  let value = localStorage.getItem(key);
  if (!value) {
    value = uid('device');
    localStorage.setItem(key, value);
  }
  return value;
}

function now() {
  return new Date().toISOString();
}

function setHistory(items) {
  state.ui.history = [...items];
}

function enterGuideHome() {
  renderGuideHome();
  setHistory(['launcher', 'guideHome']);
  showView('guideHome', false);
}

function saveSession() {
  localStorage.setItem(SESSION_KEY, JSON.stringify(state.session));
}

function saveTheme() {
  localStorage.setItem(THEME_KEY, state.theme);
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function isRemoteModeEnabled() {
  return Boolean(state.remote.enabled);
}

function getAppModeLabel() {
  return isRemoteModeEnabled() ? REMOTE_APP_MODE_LABEL : LOCAL_APP_MODE_LABEL;
}

function getSharedPayloadTemplate() {
  const seed = buildSeedData();
  return extractSharedPayload(seed);
}

function extractSharedPayload(data = state.data) {
  const source = data || buildSeedData();
  return {
    categories: clone(Array.isArray(source.categories) ? source.categories : []),
    posts: clone(Array.isArray(source.posts) ? source.posts : []),
    notices: clone(Array.isArray(source.notices) ? source.notices : []),
    suggestions: clone(Array.isArray(source.suggestions) ? source.suggestions : []),
    logs: clone(Array.isArray(source.logs) ? source.logs : []),
  };
}

function mapAdminProfileToState(profile) {
  return {
    id: profile.id,
    nickname: profile.nickname || profile.username || profile.email || '관리자',
    username: profile.username || profile.email || profile.id,
    email: profile.email || '',
    password: '',
    color: profile.color || '#3a7bff',
    isSuperAdmin: Boolean(profile.is_super_admin),
    disabled: Boolean(profile.disabled),
    createdAt: profile.created_at || now(),
    createdBy: profile.created_by || 'supabase',
    lastLoginIp: profile.last_login_ip || '',
    lastLoginAt: profile.last_login_at || '',
  };
}

function mapPresenceRow(row) {
  return {
    key: row.session_id,
    nickname: row.nickname || '알 수 없음',
    isAdmin: Boolean(row.is_admin),
    ip: row.ip || '',
    lastSeenAt: row.last_seen_at || '',
    adminId: row.admin_id || null,
    deviceId: row.device_id || null,
  };
}

function applyRemoteSnapshot(sharedPayload, adminProfiles = [], presenceRows = null) {
  const normalized = normalizeLoadedData(isPlainObject(sharedPayload) ? sharedPayload : getSharedPayloadTemplate());
  normalized.admins = adminProfiles.map(mapAdminProfileToState);
  normalized.knownUsers = [];
  state.data = normalized;
  if (Array.isArray(presenceRows)) {
    state.presenceUsers = presenceRows.map(mapPresenceRow);
  }
  state.remote.lastSyncedAt = now();
}

function renderAdminOverviewMeta() {
  if (!els.adminOverviewMeta) return;
  if (!isRemoteModeEnabled()) {
    els.adminOverviewMeta.textContent = '로컬 모드에서는 자동 5초 동기화를 사용하지 않습니다.';
    return;
  }
  const parts = ['5초 자동 반영: 접속 현황만'];
  if (state.remote.lastSyncedAt) parts.push(`마지막 전체 동기화 ${formatDate(state.remote.lastSyncedAt)}`);
  if (state.remote.lastPresenceAt) parts.push(`마지막 접속 확인 ${formatDate(state.remote.lastPresenceAt)}`);
  if (state.remote.pendingSnapshot) parts.push('서버 최신 변경 대기 중');
  if (state.remote.lastError) parts.push(`오류: ${state.remote.lastError}`);
  els.adminOverviewMeta.textContent = parts.join(' · ');
}

function renderCurrentViewOnly({ preserveAdminLayout = true } = {}) {
  updateViewerLabels();
  if (state.ui.currentView === 'launcher') {
    renderLauncher();
    return;
  }
  if (state.ui.currentView === 'nicknameEntry') {
    renderNicknameEntry();
    return;
  }
  if (state.ui.currentView === 'guideHome') {
    renderGuideHome();
    return;
  }
  if (state.ui.currentView === 'category') {
    renderCategoryView(state.ui.searchResults || null, state.ui.searchQuery || '');
    return;
  }
  if (state.ui.currentView === 'post') {
    renderPostView();
    return;
  }
  if (state.ui.currentView === 'notices') {
    renderNoticesView();
    return;
  }
  if (state.ui.currentView === 'noticeDetail') {
    renderNoticeDetailView();
    return;
  }
  if (state.ui.currentView === 'favorites') {
    renderFavoritesView();
    return;
  }
  if (state.ui.currentView === 'suggestions') {
    renderSuggestionsView();
    return;
  }
  if (state.ui.currentView === 'adminLogin') {
    renderAdminLogin();
    return;
  }
  if (state.ui.currentView === 'admin' && getCurrentAdmin()) {
    renderAdminView({ preserveLayout: preserveAdminLayout });
    return;
  }
  renderLauncher();
}

async function refreshRemotePresenceOnly({ render = true } = {}) {
  if (!isRemoteModeEnabled() || state.remote.presencePollBusy) return true;
  state.remote.presencePollBusy = true;
  try {
    const presenceResult = await fetchPresenceRows();
    if (presenceResult.error) throw presenceResult.error;
    state.presenceUsers = (presenceResult.data || []).map(mapPresenceRow);
    state.remote.lastPresenceAt = now();
    state.remote.lastError = '';
    if (render) {
      refreshLiveStatusUi();
      renderAdminOverviewMeta();
    }
    return true;
  } catch (error) {
    state.remote.lastError = error?.message || 'presence_sync_failed';
    if (render) renderAdminOverviewMeta();
    return false;
  } finally {
    state.remote.presencePollBusy = false;
  }
}

async function refreshRemoteSnapshot({ render = true, includePresence = true } = {}) {
  if (!isRemoteModeEnabled()) return true;
  if (state.remote.dataSyncBusy) return true;
  state.remote.dataSyncBusy = true;
  try {
    const tasks = [fetchSharedPayload(), fetchAdminProfiles()];
    if (includePresence) tasks.push(fetchPresenceRows());
    const [sharedResult, profilesResult, presenceResult] = await Promise.all(tasks);
    if (sharedResult.error) throw sharedResult.error;
    if (profilesResult.error) throw profilesResult.error;
    if (presenceResult?.error) throw presenceResult.error;
    const sharedPayload = sharedResult.data?.payload || getSharedPayloadTemplate();
    const nextProfiles = profilesResult.data || [];
    const nextPresence = presenceResult?.data || state.presenceUsers;
    if (render && shouldDeferRemoteApply()) {
      state.remote.pendingSnapshot = { sharedPayload, adminProfiles: nextProfiles, presenceRows: nextPresence };
      if (Array.isArray(nextPresence)) state.presenceUsers = nextPresence.map(mapPresenceRow);
      state.remote.lastError = '';
      return true;
    }
    applyRemoteSnapshot(sharedPayload, nextProfiles, nextPresence);
    state.remote.pendingSnapshot = null;
    state.remote.lastError = '';
    if (render) renderCurrentViewOnly({ preserveAdminLayout: true });
    return true;
  } catch (error) {
    state.remote.lastError = error?.message || 'remote_sync_failed';
    return false;
  } finally {
    state.remote.dataSyncBusy = false;
  }
}

async function saveData() {
  if (!isRemoteModeEnabled()) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
    return true;
  }
  const currentAdmin = getCurrentAdmin();
  const { error } = await saveSharedPayload(extractSharedPayload(state.data), currentAdmin?.id || null);
  if (error) {
    state.remote.lastError = error.message || 'remote_save_failed';
    showToast('공용 서버 저장에 실패했습니다.', 'error');
    return false;
  }
  state.remote.lastError = '';
  state.remote.lastSyncedAt = now();
  return true;
}

async function initializeRemoteMode() {
  if (!isSupabaseConfigured()) return false;
  state.remote.enabled = true;
  state.remote.initialized = true;
  const remoteSession = await getCurrentRemoteSession();
  const loaded = await refreshRemoteSnapshot({ render: false, includePresence: true });
  if (!loaded) {
    state.remote.enabled = false;
    return false;
  }
  const remoteUser = remoteSession.user;
  if (remoteUser) {
    const profile = state.data.admins.find((item) => item.id === remoteUser.id && !item.disabled);
    if (profile) {
      state.session.adminId = profile.id;
    } else {
      await signOutAdminRemote();
      state.session.adminId = null;
    }
  } else {
    state.session.adminId = null;
  }
  saveSession();
  return true;
}

async function persistPresence() {
  if (!isRemoteModeEnabled() || state.remote.presenceSyncBusy) return;
  state.remote.presenceSyncBusy = true;
  try {
    const admin = getCurrentAdmin();
    const nickname = admin?.nickname || state.session.userNickname || '';
    if (!nickname) {
      await removePresenceRow(state.session.deviceId);
      state.presenceUsers = state.presenceUsers.filter((item) => item.key !== state.session.deviceId);
      return;
    }
    const { error } = await upsertPresenceRow({
      session_id: state.session.deviceId,
      nickname,
      is_admin: Boolean(admin),
      ip: state.session.currentIp || '',
      admin_id: admin?.id || null,
      device_id: state.session.deviceId || null,
      last_seen_at: now(),
    });
    if (error) throw error;
    const presenceResult = await fetchPresenceRows();
    if (presenceResult.error) throw presenceResult.error;
    state.presenceUsers = (presenceResult.data || []).map(mapPresenceRow);
  } catch (error) {
    state.remote.lastError = error?.message || 'presence_sync_failed';
  } finally {
    state.remote.presenceSyncBusy = false;
  }
}

async function clearPresenceRecord() {
  if (!isRemoteModeEnabled()) return;
  try {
    await removePresenceRow(state.session.deviceId);
  } catch {
    // ignore cleanup errors
  }
}

function startRemoteSyncLoop() {
  if (!isRemoteModeEnabled() || state.remote.syncTimerId) return;
  state.remote.syncTimerId = setInterval(() => {
    if (state.remote.pendingSnapshot && !shouldDeferRemoteApply()) {
      applyPendingRemoteSnapshot({ render: true });
      return;
    }
    refreshRemotePresenceOnly({ render: true });
  }, REMOTE_SYNC_MS);
}

function stopRemoteSyncLoop() {
  if (!state.remote.syncTimerId) return;
  clearInterval(state.remote.syncTimerId);
  state.remote.syncTimerId = null;
}

async function syncLatestSharedData() {
  if (!isRemoteModeEnabled()) return true;
  return refreshRemoteSnapshot({ render: false, includePresence: false });
}


function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isUsingDefaultSuperAdmin() {
  if (isRemoteModeEnabled()) return false;
  return state.data.admins.some((admin) => !admin.disabled && admin.isSuperAdmin && admin.username === DEFAULT_SUPER_ADMIN.username && admin.password === DEFAULT_SUPER_ADMIN.password);
}

function normalizeLoadedData(raw) {
  if (!isPlainObject(raw)) throw new Error('invalid');
  const seed = buildSeedData();
  const data = { ...seed, ...raw };
  data.knownUsers = Array.isArray(raw.knownUsers) ? raw.knownUsers : [];
  data.categories = Array.isArray(raw.categories) ? raw.categories : clone(seed.categories);
  data.posts = Array.isArray(raw.posts) ? raw.posts : clone(seed.posts);
  data.notices = Array.isArray(raw.notices) ? raw.notices : clone(seed.notices);
  data.suggestions = Array.isArray(raw.suggestions) ? raw.suggestions : [];
  data.admins = Array.isArray(raw.admins) ? raw.admins : clone(seed.admins);
  data.logs = Array.isArray(raw.logs) ? raw.logs : clone(seed.logs);

  data.posts = data.posts
    .filter((post) => isPlainObject(post))
    .map((post) => ({
      ...post,
      aliases: Array.isArray(post.aliases) ? post.aliases : [],
      blocks: Array.isArray(post.blocks) ? post.blocks : [],
      isPublished: post.isPublished !== false,
      titleStyle: {
        color: post.titleStyle?.color || '#111827',
        fontSize: post.titleStyle?.fontSize || '15px',
        fontWeight: post.titleStyle?.fontWeight || '700',
        fontStyle: post.titleStyle?.fontStyle || 'normal',
      },
    }));

  data.admins = data.admins
    .filter((admin) => isPlainObject(admin) && admin.id && admin.username)
    .map((admin) => ({
      ...admin,
      nickname: admin.nickname || admin.username,
      color: admin.color || '#3a7bff',
      isSuperAdmin: Boolean(admin.isSuperAdmin),
      disabled: Boolean(admin.disabled),
      createdAt: admin.createdAt || now(),
      createdBy: admin.createdBy || 'import',
      lastLoginIp: admin.lastLoginIp || '',
      lastLoginAt: admin.lastLoginAt || '',
    }));

  data.categories = data.categories
    .filter((category) => isPlainObject(category) && category.id && category.name)
    .map((category, index) => ({
      ...category,
      order: Number.isFinite(Number(category.order)) ? Number(category.order) : index + 1,
      hidden: Boolean(category.hidden),
    }));

  data.notices = data.notices
    .filter((notice) => isPlainObject(notice) && notice.id && notice.title)
    .map((notice) => ({
      ...notice,
      content: notice.content || '',
      createdAt: notice.createdAt || now(),
      updatedAt: notice.updatedAt || notice.createdAt || now(),
    }));

  data.suggestions = data.suggestions
    .filter((item) => isPlainObject(item) && item.id)
    .map((item) => ({
      ...item,
      nickname: item.nickname || '익명',
      level: item.level || '-',
      title: item.title || '(제목 없음)',
      content: item.content || '',
      createdAt: item.createdAt || now(),
    }));

  data.knownUsers = data.knownUsers
    .filter((item) => isPlainObject(item) && item.key)
    .map((item) => ({
      ...item,
      nickname: item.nickname || '알 수 없음',
      isAdmin: Boolean(item.isAdmin),
      ip: item.ip || '',
      lastSeenAt: item.lastSeenAt || '',
      adminId: item.adminId || null,
      deviceId: item.deviceId || null,
    }));

  data.logs = data.logs
    .filter((item) => isPlainObject(item) && item.id && item.message)
    .map((item) => ({
      ...item,
      createdAt: item.createdAt || now(),
    }))
    .slice(0, 200);

  if (!data.admins.length && !isRemoteModeEnabled()) data.admins = clone(seed.admins);
  if (!data.categories.length) data.categories = clone(seed.categories);
  if (!data.posts.length) data.posts = clone(seed.posts);
  return data;
}

function createHtmlDocument(html = '') {
  const parser = new DOMParser();
  return parser.parseFromString(`<div id="root">${String(html || '')}</div>`, 'text/html');
}

function resetAdminTabLayout() {
  requestAnimationFrame(() => {
    const guideMain = document.querySelector('#adminView .guide-main.main-scroll');
    if (guideMain) guideMain.scrollTop = 0;
    const activePanel = document.querySelector('#adminView .admin-tab-panel.active');
    if (activePanel) activePanel.scrollTop = 0;
    const side = document.querySelector('#adminView .guide-sidebar.side-scroll');
    if (side) side.scrollTop = 0;
  });
}

function logAction(message, { persist = !isRemoteModeEnabled() } = {}) {
  state.data.logs.unshift({ id: uid('log'), message, createdAt: now() });
  state.data.logs = state.data.logs.slice(0, 60);
  if (persist) saveData();
  renderAdminOverview();
}

function getCurrentAdmin() {
  return state.data.admins.find((admin) => admin.id === state.session.adminId && !admin.disabled) || null;
}

function isSuperAdmin(admin = getCurrentAdmin()) {
  return Boolean(admin?.isSuperAdmin);
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('ko-KR', { hour12: false });
}

function getCategoryById(id) {
  return state.data.categories.find((category) => category.id === id) || null;
}

function normalizeCategoryOrder() {
  state.data.categories = state.data.categories
    .slice()
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
    .map((category, index) => ({ ...category, order: index + 1 }));
}

function isCategoryVisible(category, admin = getCurrentAdmin()) {
  return Boolean(category) && (!category.hidden || Boolean(admin));
}

function canViewPost(post, admin = getCurrentAdmin()) {
  if (!post?.isPublished) return false;
  const category = getCategoryById(post.categoryId);
  return isCategoryVisible(category, admin);
}

function getVisiblePublishedPosts(admin = getCurrentAdmin()) {
  return state.data.posts.filter((post) => canViewPost(post, admin));
}

function getSortedCategories({ includeHidden = Boolean(getCurrentAdmin()) } = {}) {
  return state.data.categories
    .filter((category) => includeHidden || !category.hidden)
    .slice()
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
}

function hasActiveEditorDraft() {
  if (state.ui.currentView !== 'admin') return false;
  if (state.ui.activeAdminTab === 'posts' && state.postDraft) return true;
  if (state.ui.activeAdminTab === 'notices' && state.noticeDraft) return true;
  return false;
}

function shouldDeferRemoteApply() {
  return hasActiveEditorDraft() || Boolean(document.activeElement?.closest?.('#postEditorForm, #noticeEditorForm'));
}

function applyPendingRemoteSnapshot({ render = true } = {}) {
  if (!state.remote.pendingSnapshot) return false;
  const pending = state.remote.pendingSnapshot;
  state.remote.pendingSnapshot = null;
  applyRemoteSnapshot(pending.sharedPayload, pending.adminProfiles, pending.presenceRows);
  if (render) renderCurrentViewOnly({ preserveAdminLayout: true });
  return true;
}

function getPostById(id) {
  return state.data.posts.find((post) => post.id === id) || null;
}

function getNoticeById(id) {
  return state.data.notices.find((notice) => notice.id === id) || null;
}

function getAdminById(id) {
  return state.data.admins.find((admin) => admin.id === id) || null;
}

function seedPost(categoryName, title, options = {}) {
  const category = stateSeedCategories().find((item) => item.name === categoryName);
  const blocks = options.blocks || [
    {
      id: uid('block'),
      type: 'text',
      text: `${title}에 대한 기본 안내 초안입니다. 실제 운영용 내용으로 바꿔서 사용하세요.`,
    },
  ];
  return {
    id: uid('post'),
    categoryId: category?.id || '',
    title,
    titleHtml: escapeHtml(title),
    summary: `${categoryName} 카테고리용 안내 글입니다.`,
    aliases: [title.replace(/\s+/g, ''), title.slice(0, 10)],
    titleStyle: {
      color: options.titleColor || '#111827',
      fontSize: options.titleSize || '15px',
      fontWeight: options.fontWeight || '700',
      fontStyle: options.fontStyle || 'normal',
    },
    blocks,
    createdAt: now(),
    updatedAt: now(),
    isPublished: true,
  };
}

function stateSeedCategories() {
  return [
    { id: 'cat_newbie', name: '뉴비전용', order: 1 },
    { id: 'cat_event', name: '이벤트', order: 2 },
    { id: 'cat_quest', name: '퀘스트', order: 3 },
    { id: 'cat_job', name: '직업', order: 4 },
    { id: 'cat_growth', name: '스펙업', order: 5 },
    { id: 'cat_weapon', name: '무기', order: 6 },
    { id: 'cat_daily', name: '일일 레이드', order: 7 },
    { id: 'cat_weekly', name: '주간 레이드', order: 8 },
    { id: 'cat_misc', name: '기타', order: 9 },
  ];
}

function buildSeedData() {
  const categories = stateSeedCategories();
  const categoryIdMap = Object.fromEntries(categories.map((item) => [item.name, item.id]));
  const postDefs = [
    ['뉴비전용', '뉴비들이 자주하는 질문에 대한 답변'],
    ['뉴비전용', '뉴비들이 자주하는 질문에 대한 답변 2탄'],
    ['뉴비전용', '채집 하는법과 전리품 사용처'],
    ['뉴비전용', '전리품 상인 사용방법'],
    ['뉴비전용', '광산 이용 방법'],
    ['뉴비전용', '상점 npc 총정리'],
    ['뉴비전용', '시장 사용방법'],
    ['뉴비전용', '양조장 이용방법'],
    ['뉴비전용', '낚시 가이드'],
    ['이벤트', '이터널 버닝 무기 수령에 관한 공략'],
    ['퀘스트', '메인퀘스트 공략 [1] (1~30)'],
    ['퀘스트', '일일퀘스트 받는법'],
    ['퀘스트', '반복퀘스트 원격으로 받는법'],
    ['퀘스트', '메인퀘스트 npc 위치(찾기 어려운 애들 위치만 정리)'],
    ['직업', '직업 평가표 - 근접 직업 편'],
    ['직업', '직업 평가표 - 원거리 직업 편'],
    ['직업', '직업 평가표 - 히든 직업 편'],
    ['스펙업', '전직 퀘스트 하는법'],
    ['스펙업', '직업무기 강화재료 총정리(4차까지)'],
    ['스펙업', '갑옷 강화재료 총정리(4차까지)'],
    ['스펙업', '도감작 가이드'],
    ['스펙업', '스텟 공략'],
    ['스펙업', '/장비 획득법'],
    ['스펙업', '장비 강화 가이드'],
    ['무기', '무기 합성 가이드'],
    ['무기', '신화등급 합성 무기 추천표'],
    ['무기', '불멸등급 합성 무기 추천표'],
    ['무기', '영원등급 합성 무기 추천표'],
    ['무기', '창세등급 합성 무기 추천표'],
    ['무기', '특수무기 정리 (성능위주)'],
    ['일일 레이드', '티쿠스 공략법'],
    ['일일 레이드', '운디네 공략법'],
    ['일일 레이드', '베로니카 공략법'],
    ['일일 레이드', '엘더샤먼 공략법'],
    ['일일 레이드', '질란트 공략법'],
    ['일일 레이드', 'KRM-100 공략법'],
    ['일일 레이드', '페르세포네 공략법'],
    ['일일 레이드', '페룬 공략법'],
    ['일일 레이드', '진 칼리드 공략법'],
    ['일일 레이드', '진 알타이르 공략법'],
    ['일일 레이드', '진 카인 공략법'],
    ['주간 레이드', '카날로아 공략법'],
    ['주간 레이드', '레이븐 공략법'],
    ['주간 레이드', '레기온의 군단장들 공략법'],
    ['주간 레이드', '바실리스크 공략법'],
    ['주간 레이드', '레기온 공략법'],
    ['주간 레이드', '카날로아(Extreme) 공략법'],
    ['기타', 'Feather 클라이언트 빨간 글씨 수정방법'],
  ];

  const posts = postDefs.map(([categoryName, title]) => ({
    id: uid('post'),
    categoryId: categoryIdMap[categoryName],
    title,
    titleHtml: escapeHtml(title),
    summary: `${categoryName} 카테고리용 기본 초안입니다.`,
    aliases: [title.replace(/\s+/g, ''), categoryName],
    titleStyle: {
      color: title === '카날로아(Extreme) 공략법' ? '#d92b21' : '#111827',
      fontSize: '15px',
      fontWeight: '700',
      fontStyle: 'normal',
    },
    blocks: [
      {
        id: uid('block'),
        type: 'text',
        text: `${title}에 대한 기본 안내 초안입니다. 실제 공략 내용을 여기에 채워 넣으세요.`,
      },
    ],
    createdAt: now(),
    updatedAt: now(),
    isPublished: true,
  }));

  return {
    categories,
    posts,
    notices: [
      {
        id: uid('notice'),
        title: '운영 안내',
        content: '운영 공지를 여기에 작성하세요. Supabase 연결 시 여러 기기에서 같은 공지를 볼 수 있습니다.',
        createdAt: now(),
        updatedAt: now(),
      },
    ],
    suggestions: [],
    knownUsers: [],
    admins: [
      {
        id: 'admin_root_penguin',
        nickname: '펭귄',
        username: 'jeonjihoo',
        password: 'caption1216!',
        color: '#3a7bff',
        isSuperAdmin: true,
        disabled: false,
        createdAt: now(),
        createdBy: 'system',
        lastLoginIp: '',
        lastLoginAt: '',
      },
    ],
    logs: [
      { id: uid('log'), message: '가이드북 초기 데이터가 준비되었습니다.', createdAt: now() },
    ],
  };
}

function loadData() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const initial = normalizeLoadedData(buildSeedData());
    localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
    return initial;
  }
  try {
    return normalizeLoadedData(JSON.parse(raw));
  } catch {
    const initial = normalizeLoadedData(buildSeedData());
    localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
    return initial;
  }
}

function loadSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return clone(state.session);
  try {
    return { ...clone(state.session), ...JSON.parse(raw) };
  } catch {
    return clone(state.session);
  }
}

function loadTheme() {
  return localStorage.getItem(THEME_KEY) || 'white';
}

async function fetchLocalIp() {
  try {
    const ip = await invoke('get_local_ip');
    if (typeof ip === 'string' && ip.trim()) return ip.trim();
  } catch {
    // ignore
  }
  return '127.0.0.1';
}

function applyTheme(themeValue) {
  state.theme = themeValue;
  saveTheme();
  const shell = document.getElementById('appShell');
  shell.className = `app-shell theme-${themeValue}`;
  Object.values(els.themeSelects).forEach((select) => {
    if (select.value !== themeValue) select.value = themeValue;
  });
}

function setupThemeOptions() {
  const options = THEMES.map((theme) => `<option value="${theme.value}">${theme.label}</option>`).join('');
  Object.values(els.themeSelects).forEach((select) => {
    select.innerHTML = options;
    select.addEventListener('change', (event) => applyTheme(event.target.value));
  });
}

function validateUserNickname(nickname) {
  return /^[A-Za-z0-9_]{3,16}$/.test(nickname);
}

function validateAdminNickname(nickname) {
  return /^[A-Za-z0-9_가-힣]{2,16}$/.test(nickname);
}

function validateAdminUsername(username) {
  return /^[A-Za-z0-9_]{4,20}$/.test(username);
}

function showToast(message, type = 'default') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  els.toastRoot.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

function setInlineMessage(element, message = '', type = '') {
  element.textContent = message;
  element.className = `inline-message${type ? ` ${type}` : ''}`;
}

function clearInlineMessages() {
  [
    els.searchMessage,
    els.suggestionFormMessage,
    els.adminLoginMessage,
    els.postEditorMessage,
    els.noticeEditorMessage,
    els.adminCreateMessage,
    els.adminColorMessage,
    els.nicknameEntryMessage,
  ].forEach((item) => item && setInlineMessage(item, ''));
}

function upsertKnownUser({ nickname, isAdmin = false, ip = state.session.currentIp, adminId = null, deviceId = state.session.deviceId }) {
  if (isRemoteModeEnabled()) return;
  if (!nickname) return;
  state.data.knownUsers ||= [];
  const key = isAdmin ? `admin:${adminId || nickname}` : `user:${deviceId || nickname}`;
  let found = state.data.knownUsers.find((item) => item.key === key);
  if (!found && !isAdmin && deviceId) {
    found = state.data.knownUsers.find((item) => !item.isAdmin && item.deviceId === deviceId);
  }
  if (!found) {
    found = { key, nickname, isAdmin, ip: '', lastSeenAt: '', adminId: adminId || null, deviceId: deviceId || null };
    state.data.knownUsers.unshift(found);
  }
  found.key = key;
  found.nickname = nickname;
  found.isAdmin = isAdmin;
  found.ip = ip || found.ip || '';
  found.lastSeenAt = now();
  found.adminId = adminId || found.adminId || null;
  found.deviceId = deviceId || found.deviceId || null;
  state.data.knownUsers = state.data.knownUsers
    .filter((item, index, arr) => arr.findIndex((entry) => entry.key === item.key) === index)
    .sort((a, b) => new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0))
    .slice(0, 50);
  saveData();
}

function removeCurrentDeviceUserPresence() {
  if (isRemoteModeEnabled()) return;
  state.data.knownUsers = (state.data.knownUsers || []).filter((item) => !(item.deviceId && item.deviceId === state.session.deviceId && !item.isAdmin));
  saveData();
}

function getActiveKnownUsers() {
  const cutoff = Date.now() - ACTIVE_TTL_MS;
  const source = isRemoteModeEnabled() ? state.presenceUsers : (state.data.knownUsers || []);
  return source.filter((item) => {
    const time = new Date(item.lastSeenAt || 0).getTime();
    return time && time >= cutoff;
  }).sort((a, b) => new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0));
}

function refreshLiveStatusUi() {
  updateViewerLabels();
  if (state.ui.currentView === 'guideHome') {
    renderOnlineUsers(els.guideOnlineUsers, els.guideOnlineCounts);
    renderStats(els.guideSidebarStats, [
      { label: '카테고리', value: state.data.categories.length },
      { label: '게시글', value: state.data.posts.length },
      { label: '건의', value: state.data.suggestions.length },
      { label: '관리자', value: state.data.admins.filter((item) => !item.disabled).length },
    ]);
  } else if (state.ui.currentView === 'category') {
    renderOnlineUsers(els.categoryOnlineUsers, els.categoryOnlineCounts);
  } else if (state.ui.currentView === 'post') {
    renderOnlineUsers(els.postOnlineUsers, els.postOnlineCounts);
  } else if (state.ui.currentView === 'favorites') {
    renderOnlineUsers(els.favoritesOnlineUsers, els.favoritesOnlineCounts);
  } else if (state.ui.currentView === 'suggestions') {
    renderOnlineUsers(els.suggestionsOnlineUsers, els.suggestionsOnlineCounts);
  } else if (state.ui.currentView === 'notices') {
    // static sidebar only
  } else if (state.ui.currentView === 'noticeDetail') {
    // static detail view
  } else if (state.ui.currentView === 'admin') {
    renderOnlineUsers(els.adminOnlineUsers, els.adminOnlineCounts);
    renderStats(els.adminSidebarStats, [
      { label: '카테고리', value: state.data.categories.length },
      { label: '게시글', value: state.data.posts.length },
      { label: '건의', value: state.data.suggestions.length },
      { label: '관리자', value: state.data.admins.filter((item) => !item.disabled).length },
    ]);
    renderAdminOverviewMeta();
  }
}

function startHeartbeat() {
  const beat = () => {
    const admin = getCurrentAdmin();
    if (isRemoteModeEnabled()) {
      persistPresence();
    } else if (admin) {
      upsertKnownUser({ nickname: admin.nickname, isAdmin: true, adminId: admin.id, ip: state.session.currentIp });
    } else if (state.session.userNickname) {
      upsertKnownUser({ nickname: state.session.userNickname, isAdmin: false, ip: state.session.currentIp });
    }
    refreshLiveStatusUi();
  };
  beat();
  setInterval(beat, HEARTBEAT_MS);
}

function renderOnlineUsers(listEl, countEl) {
  if (!listEl) return;
  const currentAdmin = getCurrentAdmin();
  const activeUsers = getActiveKnownUsers();
  const admins = activeUsers.filter((item) => item.isAdmin);
  const users = activeUsers.filter((item) => !item.isAdmin);
  if (countEl) countEl.textContent = `${isRemoteModeEnabled() ? '실시간 접속' : '최근 기록'} 관리자 ${admins.length}명 · 유저 ${users.length}명`;
  listEl.innerHTML = activeUsers.length
    ? activeUsers.slice(0, 20).map((item) => {
        const suffix = item.isAdmin ? '(관리자)' : '';
        const ipText = currentAdmin && item.ip ? `(${item.ip})` : '';
        return `<div class="user-row compact-user-row"><span class="user-name">${escapeHtml(item.nickname)}${suffix}${escapeHtml(ipText)}</span><span class="online-dot"></span></div>`;
      }).join('')
    : '<div class="empty-state compact-empty">최근 기록이 없습니다.</div>';
}

function openNicknameEntry(returnView = 'guideHome') {
  state.ui.returnAfterNickname = returnView;
  renderNicknameEntry();
  showView('nicknameEntry');
}

function renderNicknameEntry() {
  setInlineMessage(els.nicknameEntryMessage, '');
  els.nicknameEntryInput.value = state.session.userNickname || '';
  setTimeout(() => els.nicknameEntryInput.focus(), 0);
}

function saveNicknameEntry() {
  const nickname = els.nicknameEntryInput.value.trim();
  if (!validateUserNickname(nickname)) {
    setInlineMessage(els.nicknameEntryMessage, '닉네임은 영문, 숫자, 밑줄만 가능하며 3~16자여야 합니다.', 'error');
    return;
  }
  state.session.userNickname = nickname;
  saveSession();
  if (!getCurrentAdmin()) upsertKnownUser({ nickname, isAdmin: false });
  updateViewerLabels();
  renderAll();
  showToast('닉네임이 저장되었습니다.', 'success');
  enterGuideHome();
}

function registerEls() {
  const byId = (id) => document.getElementById(id);
  Object.assign(els, {
    toastRoot: byId('toastRoot'),
    launcherAdminButton: byId('launcherAdminButton'),
    openGuideButton: byId('openGuideButton'),
    nicknameEntryForm: byId('nicknameEntryForm'),
    nicknameEntryInput: byId('nicknameEntryInput'),
    nicknameEntryMessage: byId('nicknameEntryMessage'),
    cancelNicknameButton: byId('cancelNicknameButton'),
    globalBackButton: byId('globalBackButton'),
    guideSearchInput: byId('guideSearchInput'),
    searchSuggestions: byId('searchSuggestions'),
    searchModeSelect: byId('searchModeSelect'),
    runSearchButton: byId('runSearchButton'),
    searchMessage: byId('searchMessage'),
    categoryGrid: byId('categoryGrid'),
    homeStats: byId('homeStats'),
    onlineUsersCounts: byId('onlineUsersCounts'),
    onlineUsersList: byId('onlineUsersList'),
    noticeList: byId('noticeList'),
    noticePreviewList: byId('noticePreviewList'),
    noticePreviewMoreButton: byId('noticePreviewMoreButton'),
    changeNicknameButton: byId('changeNicknameButton'),
    viewerLabel: byId('viewerLabel'),
    favoritesNavButton: byId('favoritesNavButton'),
    suggestionNavButton: byId('suggestionNavButton'),
    guideLogoutButton: byId('guideLogoutButton'),
    guideAdminToolsButton: byId('guideAdminToolsButton'),
    guideNoticeNavButton: byId('guideNoticeNavButton'),
    categoryTitle: byId('categoryTitle'),
    categorySubtitle: byId('categorySubtitle'),
    categoryPostList: byId('categoryPostList'),
    categoryViewerLabel: byId('categoryViewerLabel'),
    categoryHomeButton: byId('categoryHomeButton'),
    categoryFavoritesButton: byId('categoryFavoritesButton'),
    categoryNoticeButton: byId('categoryNoticeButton'),
    categorySuggestionsButton: byId('categorySuggestionsButton'),
    categoryNicknameButton: byId('categoryNicknameButton'),
    categoryOnlineUsersCounts: byId('categoryOnlineUsersCounts'),
    categoryOnlineUsersList: byId('categoryOnlineUsersList'),
    categoryLogoutButton: byId('categoryLogoutButton'),
    categoryAdminToolsButton: byId('categoryAdminToolsButton'),
    postCategoryLabel: byId('postCategoryLabel'),
    postTitle: byId('postTitle'),
    postSummary: byId('postSummary'),
    postMeta: byId('postMeta'),
    postContentBlocks: byId('postContentBlocks'),
    toggleFavoriteButton: byId('toggleFavoriteButton'),
    changeNicknameFromPostButton: byId('changeNicknameFromPostButton'),
    openPostEditButton: byId('openPostEditButton'),
    postLogoutButton: byId('postLogoutButton'),
    postAdminToolsButton: byId('postAdminToolsButton'),
    postNoticeButton: byId('postNoticeButton'),
    favoritesList: byId('favoritesList'),
    favoritesViewerLabel: byId('favoritesViewerLabel'),
    favoritesNoticeButton: byId('favoritesNoticeButton'),
    favoritesChangeNicknameButton: byId('favoritesChangeNicknameButton'),
    favoritesLogoutButton: byId('favoritesLogoutButton'),
    favoritesAdminToolsButton: byId('favoritesAdminToolsButton'),
    suggestionForm: byId('suggestionForm'),
    suggestionNickname: byId('suggestionNickname'),
    suggestionLevel: byId('suggestionLevel'),
    suggestionTitle: byId('suggestionTitle'),
    suggestionContent: byId('suggestionContent'),
    suggestionFormMessage: byId('suggestionFormMessage'),
    suggestionsViewerLabel: byId('suggestionsViewerLabel'),
    suggestionsNoticeButton: byId('suggestionsNoticeButton'),
    suggestionsChangeNicknameButton: byId('suggestionsChangeNicknameButton'),
    suggestionsLogoutButton: byId('suggestionsLogoutButton'),
    suggestionsAdminToolsButton: byId('suggestionsAdminToolsButton'),
    adminLoginForm: byId('adminLoginForm'),
    adminLoginThemeSelect: byId('adminLoginThemeSelect'),
    adminLoginId: byId('adminLoginId'),
    adminLoginPassword: byId('adminLoginPassword'),
    adminRememberId: byId('adminRememberId'),
    adminLoginMessage: byId('adminLoginMessage'),
    adminTopIdentity: byId('adminTopIdentity'),
    adminViewerLabel: byId('adminViewerLabel'),
    adminLogoutButton: byId('adminLogoutButton'),
    adminHomeButton: byId('adminHomeButton'),
    adminNoticeButton: byId('adminNoticeButton'),
    adminFavoritesButton: byId('adminFavoritesButton'),
    adminSuggestionsButton: byId('adminSuggestionsButton'),
    adminNicknameButton: byId('adminNicknameButton'),
    adminLogoutButtonSide: byId('adminLogoutButtonSide'),
    noticesList: byId('noticesList'),
    noticesViewerLabel: byId('noticesViewerLabel'),
    noticesHomeButton: byId('noticesHomeButton'),
    noticesFavoritesButton: byId('noticesFavoritesButton'),
    noticesSuggestionsButton: byId('noticesSuggestionsButton'),
    noticesChangeNicknameButton: byId('noticesChangeNicknameButton'),
    noticesAdminToolsButton: byId('noticesAdminToolsButton'),
    noticesLogoutButton: byId('noticesLogoutButton'),
    noticeDetailTitle: byId('noticeDetailTitle'),
    noticeDetailMeta: byId('noticeDetailMeta'),
    noticeDetailContent: byId('noticeDetailContent'),
    noticeDetailHomeButton: byId('noticeDetailHomeButton'),
    noticeDetailAdminToolsButton: byId('noticeDetailAdminToolsButton'),
    noticeDetailLogoutButton: byId('noticeDetailLogoutButton'),
    adminSidebarStats: byId('adminSidebarStats'),
    adminOnlineCounts: byId('adminOnlineCounts'),
    adminOnlineUsers: byId('adminOnlineUsers'),
    adminStats: byId('adminStats'),
    addCategoryButton: byId('addCategoryButton'),
    adminCategoryList: byId('adminCategoryList'),
    adminLogList: byId('adminLogList'),
    adminPostList: byId('adminPostList'),
    newPostButton: byId('newPostButton'),
    postEditorForm: byId('postEditorForm'),
    postEditorEmpty: byId('postEditorEmpty'),
    postEditorCategory: byId('postEditorCategory'),
    postEditorTitleRich: byId('postEditorTitleRich'),
    postEditorSummary: byId('postEditorSummary'),
    postEditorTitleColor: byId('postEditorTitleColor'),
    titleBoldButton: byId('titleBoldButton'),
    titleItalicButton: byId('titleItalicButton'),
    titleUnderlineButton: byId('titleUnderlineButton'),
    bodyBoldButton: byId('bodyBoldButton'),
    bodyItalicButton: byId('bodyItalicButton'),
    bodyUnderlineButton: byId('bodyUnderlineButton'),
    postEditorBodyColor: byId('postEditorBodyColor'),
    postEditorBody: byId('postEditorBody'),
    selectedMediaWidth: byId('selectedMediaWidth'),
    applySelectedMediaWidthButton: byId('applySelectedMediaWidthButton'),
    editorInsertPanel: byId('editorInsertPanel'),
    editorInsertTitle: byId('editorInsertTitle'),
    mediaInsertUrl: byId('mediaInsertUrl'),
    confirmInsertByUrlButton: byId('confirmInsertByUrlButton'),
    mediaFileInput: byId('mediaFileInput'),
    cancelInsertPanelButton: byId('cancelInsertPanelButton'),
    previewPostButton: byId('previewPostButton'),
    addImageBlockButton: byId('addImageBlockButton'),
    addVideoBlockButton: byId('addVideoBlockButton'),
    postEditorMessage: byId('postEditorMessage'),
    deletePostButton: byId('deletePostButton'),
    cancelPostEditButton: byId('cancelPostEditButton'),
    adminNoticeList: byId('adminNoticeList'),
    newNoticeButton: byId('newNoticeButton'),
    noticeEditorForm: byId('noticeEditorForm'),
    noticeEditorEmpty: byId('noticeEditorEmpty'),
    noticeEditorTitle: byId('noticeEditorTitle'),
    noticeEditorContent: byId('noticeEditorContent'),
    noticeEditorMessage: byId('noticeEditorMessage'),
    deleteNoticeButton: byId('deleteNoticeButton'),
    cancelNoticeEditButton: byId('cancelNoticeEditButton'),
    adminSuggestionList: byId('adminSuggestionList'),
    adminAccountList: byId('adminAccountList'),
    adminCreateForm: byId('adminCreateForm'),
    adminCreateNickname: byId('adminCreateNickname'),
    adminCreateUsername: byId('adminCreateUsername'),
    adminCreatePassword: byId('adminCreatePassword'),
    adminCreatePasswordConfirm: byId('adminCreatePasswordConfirm'),
    adminCreateMessage: byId('adminCreateMessage'),
    cancelAdminCreateButton: byId('cancelAdminCreateButton'),
    adminColorForm: byId('adminColorForm'),
    adminColorTargetName: byId('adminColorTargetName'),
    adminColorInput: byId('adminColorInput'),
    adminColorMessage: byId('adminColorMessage'),
    adminPasswordForm: byId('adminPasswordForm'),
    adminPasswordTargetName: byId('adminPasswordTargetName'),
    adminPasswordHint: byId('adminPasswordHint'),
    adminCurrentPassword: byId('adminCurrentPassword'),
    adminNewPassword: byId('adminNewPassword'),
    adminNewPasswordConfirm: byId('adminNewPasswordConfirm'),
    adminPasswordMessage: byId('adminPasswordMessage'),
    deleteAdminButton: byId('deleteAdminButton'),
    openAdminCreateButton: byId('openAdminCreateButton'),
    adminAccountEmpty: byId('adminAccountEmpty'),
    exportDataButton: byId('exportDataButton'),
    importDataInput: byId('importDataInput'),
    resetSeedButton: byId('resetSeedButton'),
    adminOverviewMeta: byId('adminOverviewMeta'),
    adminSyncNowButton: byId('adminSyncNowButton'),
    detailModal: byId('detailModal'),
    detailModalTitle: byId('detailModalTitle'),
    detailModalBody: byId('detailModalBody'),
    detailModalClose: byId('detailModalClose'),
  });
  els.views = {
    launcher: byId('launcherView'),
    nicknameEntry: byId('nicknameEntryView'),
    guideHome: byId('guideHomeView'),
    category: byId('categoryView'),
    post: byId('postView'),
    favorites: byId('favoritesView'),
    suggestions: byId('suggestionsView'),
    notices: byId('noticesView'),
    noticeDetail: byId('noticeDetailView'),
    adminLogin: byId('adminLoginView'),
    admin: byId('adminView'),
  };
  els.themeSelects = {
    launcher: byId('launcherThemeSelect'),
    nicknameEntry: byId('nicknameThemeSelect'),
    guideHome: byId('innerThemeSelect'),
    category: byId('categoryThemeSelect'),
    post: byId('postThemeSelect'),
    favorites: byId('favoritesThemeSelect'),
    suggestions: byId('suggestionsThemeSelect'),
    notices: byId('noticesThemeSelect'),
    noticeDetail: byId('noticeDetailThemeSelect'),
    adminLogin: byId('adminLoginThemeSelect'),
    admin: byId('adminThemeSelect'),
  };
  els.adminTabs = Array.from(document.querySelectorAll('.admin-tab'));
  els.backButtons = Array.from(document.querySelectorAll('.back-btn'));
}

function showView(name, push = true) {
  Object.entries(els.views).forEach(([key, section]) => section.classList.toggle('active', key === name));
  state.ui.currentView = name;
  if (push) {
    const last = state.ui.history[state.ui.history.length - 1];
    if (last !== name) state.ui.history.push(name);
  }
}

function goBack() {
  if (state.ui.currentView === 'post' && state.ui.currentPostId === '__draft__') {
    state.ui.previewingDraft = false;
    navigate('admin', {}, false);
    state.ui.activeAdminTab = 'posts';
    renderAdminView();
    return;
  }
  if (state.ui.history.length <= 1) {
    navigate('launcher', {}, false);
    return;
  }
  state.ui.history.pop();
  const target = state.ui.history[state.ui.history.length - 1] || 'launcher';
  navigate(target, {}, false, true);
}

function navigate(view, payload = {}, push = true, fromBack = false) {
  if (!ensureAdminSessionValid()) return;
  if (payload.categoryId) state.ui.currentCategoryId = payload.categoryId;
  if (payload.postId) state.ui.currentPostId = payload.postId;
  if (view !== 'category' && !fromBack && payload.searchResults) {
    state.ui.searchResults = payload.searchResults;
    state.ui.searchQuery = payload.query || '';
  }
  if (view === 'nicknameEntry') renderNicknameEntry();
  if (view === 'guideHome') renderGuideHome();
  if (view === 'category') renderCategoryView(payload.searchResults || null, payload.query || '');
  if (view === 'post') renderPostView();
  if (view === 'notices') renderNoticesView();
  if (view === 'noticeDetail') renderNoticeDetailView();
  if (view === 'favorites') renderFavoritesView();
  if (view === 'suggestions') renderSuggestionsView();
  if (view === 'admin') renderAdminView();
  if (view === 'launcher') renderLauncher();
  if (view === 'adminLogin') renderAdminLogin();
  showView(view, push);
}

function openGuideHome() {
  renderGuideHome();
  showView('guideHome');
}

function updateViewerLabels() {
  const admin = getCurrentAdmin();
  const plainUser = state.session.userNickname || '미등록';
  const labels = admin
    ? {
        text: `${admin.nickname}(관리자)`,
        color: admin.color,
      }
    : {
        text: plainUser,
        color: '',
      };

  [els.viewerLabel, els.categoryViewerLabel, els.favoritesViewerLabel, els.suggestionsViewerLabel, els.noticesViewerLabel]
    .filter(Boolean)
    .forEach((chip) => {
      chip.textContent = labels.text;
      chip.style.color = labels.color || '';
      chip.classList.toggle('hidden', !labels.text);
    });

  if (els.adminViewerLabel) {
    els.adminViewerLabel.textContent = admin ? `${admin.nickname}(관리자)` : '관리자';
    els.adminViewerLabel.style.color = admin?.color || '';
  }
  if (els.adminTopIdentity) {
    els.adminTopIdentity.textContent = admin ? `${admin.nickname}(관리자) · 현재 접속 IP ${admin.lastLoginIp || state.session.currentIp}` : '';
  }

  [els.guideLogoutButton, els.categoryLogoutButton, els.postLogoutButton, els.favoritesLogoutButton, els.suggestionsLogoutButton, els.noticesLogoutButton, els.noticeDetailLogoutButton].filter(Boolean).forEach((button) => {
    button.classList.toggle('hidden', !admin);
  });

  [els.guideAdminToolsButton, els.categoryAdminToolsButton, els.postAdminToolsButton, els.favoritesAdminToolsButton, els.suggestionsAdminToolsButton, els.noticesAdminToolsButton, els.noticeDetailAdminToolsButton].filter(Boolean).forEach((button) => {
    button.classList.remove('hidden');
    button.textContent = admin ? '관리 도구' : 'Admin';
  });

  if (els.launcherAdminButton) {
    els.launcherAdminButton.textContent = admin ? '로그아웃' : 'Admin';
  }
  [els.changeNicknameButton, els.categoryNicknameButton, els.changeNicknameFromPostButton, els.favoritesChangeNicknameButton, els.suggestionsChangeNicknameButton, els.adminNicknameButton, els.noticesChangeNicknameButton].filter(Boolean).forEach((button) => {
    button.classList.toggle('hidden', Boolean(admin));
  });
}



function openDetailModal(title, message) {
  if (!els.detailModal || !els.detailModalTitle || !els.detailModalBody) return;
  els.detailModalTitle.textContent = title || '상세 보기';
  const safe = escapeHtml(String(message || ''));
  els.detailModalBody.innerHTML = `<div class="detail-modal-text">${safe.replace(/\n/g, '<br/>')}</div>`;
  els.detailModal.classList.remove('hidden');
  els.detailModal.setAttribute('aria-hidden', 'false');
}

function closeDetailModal() {
  if (!els.detailModal) return;
  els.detailModal.classList.add('hidden');
  els.detailModal.setAttribute('aria-hidden', 'true');
}

function renderLauncher() {
  updateViewerLabels();
}

function renderStats(targetEl, items) {
  targetEl.innerHTML = items.map((item) => `
    <div class="stat-card">
      <span class="muted">${item.label}</span>
      <strong>${item.value}</strong>
    </div>`).join('');
}

function resolveTitleStyle(style = {}) {
  const rawColor = String(style.color || '').toLowerCase();
  const color = (!rawColor || rawColor === '#162033' || rawColor === '#111827') ? 'var(--text-color)' : style.color;
  const fontSize = style.fontSize || '18px';
  const fontWeight = style.fontWeight || '700';
  const fontStyle = style.fontStyle || 'normal';
  return `color:${color};font-size:${fontSize};font-weight:${fontWeight};font-style:${fontStyle};`;
}


function shouldBrightenThemeContent() {
  return state.theme === 'gray' || state.theme === 'dark';
}

function brightenDarkInlineColors(html) {
  const value = String(html || '');
  if (!shouldBrightenThemeContent() || !value) return value;
  return value
    .replace(/color\s*:\s*(#000(?:000)?|#111827|#162033|rgb\(0\s*,\s*0\s*,\s*0\s*\)|rgb\(17\s*,\s*24\s*,\s*39\s*\)|rgb\(22\s*,\s*32\s*,\s*51\s*\))/gi, 'color:var(--text-color)')
    .replace(/color\s*=\s*["'](#000(?:000)?|#111827|#162033)["']/gi, 'color="var(--text-color)"');
}

function renderGuideHome() {
  updateViewerLabels();
  const admin = getCurrentAdmin();
  const publishedPosts = getVisiblePublishedPosts(admin);
  const categories = getSortedCategories({ includeHidden: Boolean(admin) });
  renderStats(els.homeStats, [
    { label: '카테고리', value: categories.length },
    { label: '게시글', value: publishedPosts.length },
    { label: '건의', value: state.data.suggestions.length },
    { label: '관리자', value: state.data.admins.filter((item) => !item.disabled).length },
  ]);

  els.categoryGrid.innerHTML = categories
    .map((category) => {
      const count = publishedPosts.filter((post) => post.categoryId === category.id).length;
      return `
        <div class="category-card compact-category-row open-category-card" data-category-id="${category.id}" role="button" tabindex="0">
          <div class="category-main">
            <div class="category-card-head">
              <h4>${category.name}</h4>
              <div class="badge-row">
                ${category.hidden ? '<span class="badge">숨김</span>' : ''}
                <span class="badge">${count}개</span>
              </div>
            </div>
          </div>
          ${admin ? `<button class="button tiny outline edit-category" data-category-id="${category.id}" type="button">✎</button>` : ''}
        </div>`;
    }).join('');

  const noticeMarkup = state.data.notices.length
    ? state.data.notices.map((notice) => `
      <button class="notice-card compact-item open-notice-card" data-notice-id="${notice.id}" type="button">
        <h4 class="ellipsis-1">${escapeHtml(notice.title)}</h4>
        <p class="ellipsis-3">${escapeHtml(notice.content)}</p>
      </button>`).join('')
    : '<div class="empty-state compact-empty">공지 없음</div>';
  if (els.noticeList) els.noticeList.innerHTML = noticeMarkup;
  if (els.noticePreviewList) {
    els.noticePreviewList.innerHTML = state.data.notices.length
      ? state.data.notices.slice(0,5).map((notice) => `
        <button class="notice-preview-item open-notice-card" data-notice-id="${notice.id}" type="button">
          <strong class="ellipsis-1">${escapeHtml(notice.title)}</strong>
          <span class="ellipsis-3">${escapeHtml(notice.content)}</span>
        </button>`).join('')
      : '<div class="empty-state compact-empty">공지 없음</div>';
  }

  renderOnlineUsers(els.onlineUsersList, els.onlineUsersCounts);
  els.searchSuggestions.classList.add('hidden');
  setInlineMessage(els.searchMessage, '');
}

function searchPosts(query, mode) {
  const text = query.trim().toLowerCase();
  if (!text) return [];
  const admin = getCurrentAdmin();
  return state.data.posts.filter((post) => {
    if (!canViewPost(post, admin)) return false;
    const inTitle = post.title.toLowerCase().includes(text);
    const inAliases = (post.aliases || []).some((alias) => alias.toLowerCase().includes(text));
    const inContent = stripHtml(post.contentHtml || postContentHtmlFromPost(post) || '').toLowerCase().includes(text);
    if (mode === 'title') return inTitle || inAliases;
    if (mode === 'content') return inContent;
    return inTitle || inAliases || inContent;
  });
}

function renderSearchSuggestions() {
  const query = els.guideSearchInput.value.trim();
  if (!query) {
    els.searchSuggestions.classList.add('hidden');
    els.searchSuggestions.innerHTML = '';
    return;
  }
  const mode = els.searchModeSelect.value;
  const results = searchPosts(query, mode).slice(0, 8);
  if (!results.length) {
    els.searchSuggestions.classList.add('hidden');
    els.searchSuggestions.innerHTML = '';
    return;
  }
  els.searchSuggestions.innerHTML = results.map((post) => `
    <button class="suggestion-item suggestion-open-post" data-post-id="${post.id}" type="button">${post.title}</button>
  `).join('');
  els.searchSuggestions.classList.remove('hidden');
}

function renderCategoryView(searchResults = null, searchQuery = '') {
  updateViewerLabels();
  let title = '';
  let subtitle = '';
  let posts = [];
  if (Array.isArray(searchResults)) {
    title = '검색 결과';
    subtitle = `"${searchQuery}"에 대한 결과 ${searchResults.length}개`;
    posts = searchResults;
  } else {
    const category = getCategoryById(state.ui.currentCategoryId);
    if (!category || !isCategoryVisible(category)) {
      navigate('guideHome', {}, false);
      return;
    }
    title = category.name;
    subtitle = `${category.name} 카테고리 게시글`;
    posts = state.data.posts.filter((post) => post.categoryId === category.id && canViewPost(post));
  }
  els.categoryTitle.textContent = title;
  els.categorySubtitle.textContent = subtitle;
  const admin = getCurrentAdmin();
  els.categoryPostList.innerHTML = posts.length
    ? posts.map((post) => `
      <div class="post-card compact-item compact-post-row open-post-card" data-post-id="${post.id}" role="button" tabindex="0">
        <div class="post-main-card">
          <div class="post-row-main">
            <h4 class="ellipsis-1" style="${resolveTitleStyle(post.titleStyle)}" title="${escapeHtml(stripHtml(post.titleHtml || post.title))}">${escapeHtml(stripHtml(post.titleHtml || post.title))}</h4>
            <p class="muted compact-text ellipsis-4" title="${escapeHtml(stripHtml(post.summary || ''))}">${escapeHtml(stripHtml(post.summary || ''))}</p>
          </div>
        </div>
        ${admin ? `<button class="button tiny outline edit-post-inline" data-post-id="${post.id}" type="button">✎</button>` : ''}
      </div>`).join('')
    : '<div class="empty-state compact-empty">게시글이 없습니다.</div>';
  renderOnlineUsers(els.categoryOnlineUsersList, els.categoryOnlineUsersCounts);
}

function renderPostView() {
  updateViewerLabels();
  const isPreview = state.ui.currentPostId === '__draft__' && state.postDraft;
  const post = isPreview ? state.postDraft : getPostById(state.ui.currentPostId);
  if (!post || (!isPreview && !canViewPost(post))) {
    navigate('guideHome', {}, false);
    return;
  }
  els.postCategoryLabel.textContent = '';
  els.postTitle.innerHTML = brightenDarkInlineColors(post.titleHtml || escapeHtml(post.title));
  els.postTitle.style.cssText = resolveTitleStyle(post.titleStyle);
  els.postSummary.textContent = post.summary || '';
  els.postMeta.innerHTML = isPreview ? '<span class="badge">미리보기</span>' : '';
  const contentHtml = brightenDarkInlineColors(editorToStorageHtml(post.contentHtml || postContentHtmlFromPost(post) || ''));
  els.postContentBlocks.innerHTML = `<div class="content-block"><div class="rich-view article-read-view">${contentHtml}</div></div>`;

  const favorites = getFavoriteIds();
  const isFavorite = !isPreview && favorites.includes(post.id);
  els.toggleFavoriteButton.textContent = isFavorite ? '★ 즐겨찾기 해제' : '☆ 즐겨찾기';
  els.toggleFavoriteButton.classList.toggle('hidden', isPreview);
  els.changeNicknameFromPostButton.classList.toggle('hidden', isPreview);
  els.openPostEditButton.classList.toggle('hidden', !getCurrentAdmin() || isPreview);
  els.postAdminToolsButton.classList.toggle('hidden', isPreview);
}

function normalizeYoutubeUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./, '');
    if (host.includes('youtu.be')) {
      const id = parsed.pathname.replaceAll('/', '');
      return id ? `https://www.youtube.com/embed/${id}` : value;
    }
    if (host.includes('youtube.com') || host.includes('youtube-nocookie.com') || host.includes('music.youtube.com')) {
      if (parsed.pathname.startsWith('/embed/')) return value;
      if (parsed.pathname.startsWith('/shorts/')) {
        const id = parsed.pathname.split('/')[2];
        return id ? `https://www.youtube.com/embed/${id}` : value;
      }
      if (parsed.pathname.startsWith('/live/')) {
        const id = parsed.pathname.split('/')[2];
        return id ? `https://www.youtube.com/embed/${id}` : value;
      }
      const id = parsed.searchParams.get('v');
      return id ? `https://www.youtube.com/embed/${id}` : value;
    }
  } catch {
    return value;
  }
  return value;
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function shouldHideCaption(value) {
  const caption = String(value || '').trim();
  return !caption || /^[a-f0-9-]{20,}\.[a-z0-9]+$/i.test(caption) || /\.(png|jpe?g|gif|webp|mp4|webm|mov)$/i.test(caption) && caption.length > 18;
}

function renderContentBlock(block) {
  if (block.type === 'image') {
    const width = block.width || '100%';
    const imageUrl = block.previewUrl || block.url || '';
    const caption = shouldHideCaption(block.caption) ? '' : (block.caption || '');
    return `<div class="content-block media-content-block"><img src="${escapeHtml(imageUrl)}" alt="image" referrerpolicy="no-referrer" loading="lazy" style="width:${escapeHtml(width)};max-width:100%;height:auto;" />${caption ? `<div class="caption">${escapeHtml(caption)}</div>` : ''}</div>`;
  }
  if (block.type === 'video') {
    const sourceUrl = block.previewUrl || block.url || '';
  const embedUrl = normalizeYoutubeUrl(sourceUrl);
    const media = embedUrl.includes('youtube.com/embed/')
      ? `<div class="video-embed-wrap"><iframe src="${escapeHtml(embedUrl)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`
      : `<video controls preload="metadata" src="${escapeHtml(sourceUrl)}"></video>`;
    const caption = shouldHideCaption(block.caption) ? '' : (block.caption || '');
    return `<div class="content-block media-content-block">${media}${caption ? `<div class="caption">${escapeHtml(caption)}</div>` : ''}</div>`;
  }
  const html = block.html || escapeHtml(block.text || '').replace(/\\n/g, '<br/>');
  return `<div class="content-block"><div class="rich-view">${html}</div></div>`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getFavoriteIds() {
  try {
    return JSON.parse(localStorage.getItem('ide_online_easy_guide_book_v20_favorites') || '[]');
  } catch {
    return [];
  }
}

function setFavoriteIds(ids) {
  localStorage.setItem('ide_online_easy_guide_book_v20_favorites', JSON.stringify(ids));
}

async function editCategoryName(categoryId) {
  const admin = getCurrentAdmin();
  if (!admin) return;
  const category = getCategoryById(categoryId);
  if (!category) return;
  const nextName = window.prompt('카테고리 이름 수정', category.name);
  if (nextName === null) return;
  const trimmed = nextName.trim();
  if (!trimmed) {
    showToast('카테고리 이름을 입력해주세요.', 'error');
    return;
  }
  if (state.data.categories.some((item) => item.id !== categoryId && item.name.trim().toLowerCase() === trimmed.toLowerCase())) {
    showToast('이미 같은 이름의 카테고리가 있습니다.', 'error');
    return;
  }
  if (!(await syncLatestSharedData())) {
    showToast('공용 데이터 동기화 후 다시 시도해주세요.', 'error');
    return;
  }
  const latestCategory = getCategoryById(categoryId);
  if (!latestCategory) return;
  latestCategory.name = trimmed;
  logAction(`카테고리 수정: ${trimmed}`, { persist: false });
  await saveData();
  renderGuideHome();
  if (state.ui.currentCategoryId === categoryId && state.ui.currentView === 'category') renderCategoryView();
  if (state.ui.currentView === 'admin') renderAdminView();
  showToast('카테고리를 수정했습니다.', 'success');
}

async function addCategory() {
  const admin = getCurrentAdmin();
  if (!admin) return;
  const nextName = window.prompt('새 카테고리 이름');
  if (nextName === null) return;
  const trimmed = nextName.trim();
  if (!trimmed) {
    showToast('카테고리 이름을 입력해주세요.', 'error');
    return;
  }
  if (state.data.categories.some((item) => item.name.trim().toLowerCase() === trimmed.toLowerCase())) {
    showToast('이미 같은 이름의 카테고리가 있습니다.', 'error');
    return;
  }
  if (!(await syncLatestSharedData())) {
    showToast('공용 데이터 동기화 후 다시 시도해주세요.', 'error');
    return;
  }
  const maxOrder = state.data.categories.reduce((max, item) => Math.max(max, Number(item.order || 0)), 0);
  state.data.categories.push({ id: uid('cat'), name: trimmed, order: maxOrder + 1, hidden: false });
  normalizeCategoryOrder();
  logAction(`카테고리 추가: ${trimmed}`, { persist: false });
  await saveData();
  renderGuideHome();
  renderAdminView();
  showToast('카테고리를 추가했습니다.', 'success');
}

async function moveCategory(categoryId, direction) {
  const admin = getCurrentAdmin();
  if (!admin) return;
  if (!(await syncLatestSharedData())) {
    showToast('공용 데이터 동기화 후 다시 시도해주세요.', 'error');
    return;
  }
  normalizeCategoryOrder();
  const sorted = getSortedCategories({ includeHidden: true });
  const index = sorted.findIndex((item) => item.id === categoryId);
  if (index < 0) return;
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= sorted.length) return;
  const [item] = sorted.splice(index, 1);
  sorted.splice(targetIndex, 0, item);
  state.data.categories = sorted.map((category, orderIndex) => ({ ...category, order: orderIndex + 1 }));
  logAction(`카테고리 순서 변경: ${item.name}`, { persist: false });
  await saveData();
  renderGuideHome();
  renderAdminView();
  showToast('카테고리 순서를 변경했습니다.', 'success');
}

async function toggleCategoryVisibility(categoryId) {
  const admin = getCurrentAdmin();
  if (!admin) return;
  if (!(await syncLatestSharedData())) {
    showToast('공용 데이터 동기화 후 다시 시도해주세요.', 'error');
    return;
  }
  const target = getCategoryById(categoryId);
  if (!target) return;
  target.hidden = !target.hidden;
  logAction(`카테고리 ${target.hidden ? '숨김' : '노출'}: ${target.name}`, { persist: false });
  await saveData();
  if (state.ui.currentCategoryId === categoryId && state.ui.currentView === 'category' && target.hidden && !getCurrentAdmin()) {
    navigate('guideHome', {}, false);
  }
  renderGuideHome();
  renderAdminView();
  showToast(target.hidden ? '카테고리를 숨김 처리했습니다.' : '카테고리를 다시 노출했습니다.', 'success');
}

function renderAdminCategoryManager() {
  if (!els.adminCategoryList || !els.addCategoryButton) return;
  const categories = getSortedCategories({ includeHidden: true });
  els.adminCategoryList.innerHTML = categories.map((category, index) => `
    <div class="post-card admin-list-card compact-item">
      <div class="post-row-main">
        <h4 class="ellipsis-1">${escapeHtml(category.name)}</h4>
        <p class="muted">정렬 ${category.order}${category.hidden ? ' · 숨김 상태' : ''}</p>
      </div>
      <div class="card-actions wrap">
        <button class="button tiny outline category-move-up" data-category-id="${category.id}" type="button" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button class="button tiny outline category-move-down" data-category-id="${category.id}" type="button" ${index === categories.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="button tiny outline edit-category" data-category-id="${category.id}" type="button">이름 변경</button>
        <button class="button tiny ${category.hidden ? 'outline' : 'danger-soft'} toggle-category-visibility" data-category-id="${category.id}" type="button">${category.hidden ? '다시 노출' : '숨김'}</button>
      </div>
    </div>`).join('') || '<div class="empty-state compact-empty">카테고리가 없습니다.</div>';
}

function renderNoticesView() {
  updateViewerLabels();
  if (!els.noticesList) return;
  els.noticesList.innerHTML = state.data.notices.length
    ? state.data.notices.map((notice) => `
      <button class="notice-card compact-item open-notice-card" data-notice-id="${notice.id}" type="button">
        <h4 class="ellipsis-1">${escapeHtml(notice.title)}</h4>
        <p class="ellipsis-3">${escapeHtml(notice.content)}</p>
      </button>`).join('')
    : '<div class="empty-state compact-empty">공지 없음</div>';
}

function renderNoticeDetailView() {
  updateViewerLabels();
  const notice = getNoticeById(state.ui.currentNoticeId);
  if (!notice) {
    navigate('notices', {}, false);
    return;
  }
  els.noticeDetailTitle.textContent = notice.title;
  els.noticeDetailMeta.textContent = formatDate(notice.updatedAt || notice.createdAt);
  els.noticeDetailContent.innerHTML = `<div class="content-block"><div class="rich-view article-read-view"><p>${escapeHtml(notice.content).replace(/\n/g, '<br/>')}</p></div></div>`;
}

function renderFavoritesView() {
  updateViewerLabels();
  const favorites = getFavoriteIds();
  const posts = state.data.posts.filter((post) => favorites.includes(post.id) && canViewPost(post));
  els.favoritesList.innerHTML = posts.length
    ? posts.map((post) => `
      <div class="post-card compact-item open-post-card" data-post-id="${post.id}" role="button" tabindex="0">
        <h4 style="${resolveTitleStyle(post.titleStyle)}">${escapeHtml(stripHtml(post.titleHtml || post.title))}</h4>
        <p class="muted">${post.summary || ''}</p>
      </div>`).join('')
    : '<div class="empty-state">즐겨찾기한 게시글이 없습니다.</div>';
}

function renderSuggestionsView() {
  updateViewerLabels();
  els.suggestionNickname.value = state.session.userNickname || '';
  setInlineMessage(els.suggestionFormMessage, '');
}

function renderAdminLogin() {
  setInlineMessage(els.adminLoginMessage, '');
  if (els.adminLoginId) { els.adminLoginId.value = state.session.rememberedAdminUsername || ''; els.adminLoginId.setAttribute('autocomplete', 'off'); els.adminLoginId.placeholder = isRemoteModeEnabled() ? 'admin@example.com' : ''; }
  if (els.adminLoginPassword) { els.adminLoginPassword.value = ''; els.adminLoginPassword.setAttribute('autocomplete', 'new-password'); }
  if (els.adminRememberId) els.adminRememberId.checked = Boolean(state.session.rememberAdminUsername && state.session.rememberedAdminUsername);
}

function renderAdminOverview() {
  const admin = getCurrentAdmin();
  if (!admin) return;
  renderStats(els.adminStats, [
    { label: '카테고리', value: state.data.categories.length },
    { label: '게시글', value: state.data.posts.length },
    { label: '건의', value: state.data.suggestions.length },
    { label: '관리자', value: state.data.admins.filter((item) => !item.disabled).length },
  ]);
  const warningCards = [
    `<div class="ops-warning-card"><strong>운영 모드</strong><p>${getAppModeLabel()} · ${isRemoteModeEnabled() ? '공용 DB 기준으로 여러 기기에서 같은 데이터가 동기화됩니다. 편집 중에는 자동 동기화를 보류하고, 편집이 끝나면 최신 상태를 다시 반영합니다.' : '이 버전은 localStorage 기반이라 여러 기기 실시간 동기화 운영이 아닙니다.'}</p></div>`,
    state.remote.lastError
      ? `<div class="ops-warning-card danger"><strong>동기화 경고</strong><p>${escapeHtml(state.remote.lastError)}</p></div>`
      : '',
    isUsingDefaultSuperAdmin()
      ? `<div class="ops-warning-card danger"><strong>기본 관리자 계정 사용 중</strong><p>기본 관리자 아이디/비밀번호가 그대로 남아 있습니다. 운영 전 반드시 변경하세요.</p></div>`
      : '',
  ].filter(Boolean).join('');
  renderAdminCategoryManager();
  renderAdminOverviewMeta();
  const logCards = state.data.logs.length
    ? state.data.logs.map((item) => `
      <button class="log-item log-item-button open-log-detail" data-log-id="${item.id}" type="button" title="클릭해서 전체 내용 보기">
        <strong class="ellipsis-1" title="${escapeHtml(item.message)}">${escapeHtml(item.message)}</strong>
        <p class="muted">${formatDate(item.createdAt)}</p>
      </button>`).join('')
    : '<div class="empty-state">로그 없음</div>';
  els.adminLogList.innerHTML = `${warningCards}${logCards}`;
}

function renderAdminPostList() {
  els.adminPostList.innerHTML = state.data.posts
    .map((post) => {
      const category = getCategoryById(post.categoryId);
      return `
        <div class="post-card admin-list-card">
          <h4 class="ellipsis-1" title="${escapeHtml(post.title)}">${escapeHtml(post.title)}</h4>
          <p class="muted ellipsis-3" title="${escapeHtml(category?.name || '-')} · ${formatDate(post.updatedAt)}">${escapeHtml(category?.name || "-")} · ${formatDate(post.updatedAt)}</p>
          <div class="card-actions">
            <button class="button outline edit-post" data-post-id="${post.id}" type="button">✎ 편집</button>
          </div>
        </div>`;
    }).join('');
}

function renderAdminNoticeList() {
  els.adminNoticeList.innerHTML = state.data.notices.length
    ? state.data.notices.map((notice) => `
      <div class="notice-card admin-list-card">
        <h4 class="ellipsis-1" title="${escapeHtml(notice.title)}">${escapeHtml(notice.title)}</h4>
        <p class="ellipsis-3" title="${escapeHtml(notice.content)}">${escapeHtml(notice.content)}</p>
        <div class="card-actions">
          <button class="button outline edit-notice" data-notice-id="${notice.id}" type="button">✎ 편집</button>
        </div>
      </div>`).join('')
    : '<div class="empty-state">공지 없음</div>';
}

function renderAdminSuggestionList() {
  els.adminSuggestionList.innerHTML = state.data.suggestions.length
    ? state.data.suggestions.map((suggestion) => `
      <div class="suggestion-card admin-list-card">
        <h4 class="ellipsis-1" title="${escapeHtml(suggestion.title)}">${escapeHtml(suggestion.title)}</h4>
        <p class="ellipsis-3" title="${escapeHtml(suggestion.content)}">${escapeHtml(suggestion.content)}</p>
        <div class="badge-row">
          <span class="badge">닉네임 ${escapeHtml(suggestion.nickname)}</span>
          <span class="badge">레벨 ${escapeHtml(suggestion.level)}</span>
          <span class="badge">${formatDate(suggestion.createdAt)}</span>
        </div>
        <div class="card-actions">
          <button class="button outline create-post-from-suggestion" data-suggestion-id="${suggestion.id}" type="button">게시글 초안 만들기</button>
        </div>
      </div>`).join('')
    : '<div class="empty-state">들어온 건의가 없습니다.</div>';
}

function renderAdminAccounts() {
  const admin = getCurrentAdmin();
  const activeAdmins = state.data.admins.filter((item) => !item.disabled);
  const createCard = isSuperAdmin(admin)
    ? `
      <div class="admin-account-card">
        <h4>${isRemoteModeEnabled() ? '관리자 계정 안내' : '새 관리자 만들기'}</h4>
        <p class="muted">${isRemoteModeEnabled() ? '다중 사용자 운영판에서는 관리자 생성/초기 비밀번호 발급을 Supabase Auth 대시보드에서 처리합니다.' : '닉네임, 아이디, 비밀번호만 입력하면 생성됩니다.'}</p>
        <div class="card-actions">
          <button class="button primary open-create-admin" type="button">${isRemoteModeEnabled() ? '생성 안내 보기' : '관리자 생성'}</button>
        </div>
      </div>`
    : '';
  els.adminAccountList.innerHTML = createCard + activeAdmins.map((item) => `
      <div class="admin-account-card admin-list-card">
        <h4 class="ellipsis-1" style="color:${item.color};" title="${escapeHtml(item.nickname)}${item.lastLoginIp ? `(${item.lastLoginIp})` : ''}">${item.nickname}${item.lastLoginIp ? `(${item.lastLoginIp})` : ''}</h4>
        <p class="muted ellipsis-1" title="${escapeHtml(item.email || item.username)}">${escapeHtml(item.email || item.username)}</p>
        <div class="card-actions">
          <button class="button outline select-admin-account" data-admin-id="${item.id}" type="button">선택</button>
        </div>
      </div>`).join('');
}

function renderAdminView({ preserveLayout = true } = {}) {
  const admin = getCurrentAdmin();
  if (!admin) {
    navigate('adminLogin', {}, false);
    return;
  }
  const shouldResetLayout = !preserveLayout || state.ui.lastRenderedAdminTab !== state.ui.activeAdminTab;
  state.ui.lastRenderedAdminTab = state.ui.activeAdminTab;
  updateViewerLabels();
  els.adminTabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === state.ui.activeAdminTab));
  document.querySelectorAll('.admin-tab-panel').forEach((panel) => panel.classList.remove('active'));
  document.getElementById(`admin${capitalize(state.ui.activeAdminTab)}Tab`).classList.add('active');
  renderAdminOverview();
  renderAdminPostList();
  renderAdminNoticeList();
  renderAdminSuggestionList();
  renderAdminAccounts();
  renderPostEditor();
  renderNoticeEditor();
  renderAdminAccountEditor();
  renderStats(els.adminSidebarStats, [
    { label: '카테고리', value: state.data.categories.length },
    { label: '게시글', value: state.data.posts.length },
    { label: '건의', value: state.data.suggestions.length },
    { label: '관리자', value: state.data.admins.filter((item) => !item.disabled).length },
  ]);
  renderOnlineUsers(els.adminOnlineUsers, els.adminOnlineCounts);
  renderAdminOverviewMeta();
  if (shouldResetLayout) resetAdminTabLayout();
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}


function postContentHtmlFromPost(post) {
  if (post?.contentHtml) return String(post.contentHtml);
  if (!Array.isArray(post?.blocks)) return '';
  return post.blocks.map((block) => renderContentBlock(block)).join('');
}

function normalizeEditorHtml(html) {
  return String(html || '')
    .replace(/<div><br><\/div>/gi, '')
    .trim();
}

function normalizeTitleHtml(html) {
  return String(html || '')
    .replace(/<div><br><\/div>/gi, '')
    .replace(/<p><br><\/p>/gi, '')
    .trim();
}

function hasMeaningfulEditorContent(html) {
  return Boolean(stripHtml(html).trim() || /<(img|video|iframe)\b/i.test(html));
}

let savedEditorRange = null;
let selectedMediaElement = null;
let insertionMarkerId = null;
let draggedMediaElement = null;

function createEmptyEditorParagraph(doc = document, slotType = '') {
  const p = doc.createElement('p');
  if (slotType) {
    p.className = 'media-text-slot';
    p.setAttribute('data-slot-type', slotType);
  }
  p.appendChild(doc.createElement('br'));
  return p;
}

function isMediaTextSlot(node) {
  return Boolean(node && node.nodeType === 1 && node.matches('p.media-text-slot'));
}

function getMediaAdjacentSlot(figure, direction) {
  if (!figure) return null;
  const sibling = direction === 'before' ? figure.previousElementSibling : figure.nextElementSibling;
  if (isMediaTextSlot(sibling)) return sibling;
  return null;
}

function ensureMediaAdjacentSlot(figure, direction) {
  if (!figure) return null;
  const existing = getMediaAdjacentSlot(figure, direction);
  if (existing) return existing;
  const slot = createEmptyEditorParagraph(figure.ownerDocument || document, direction);
  if (direction === 'before') figure.before(slot);
  else figure.after(slot);
  return slot;
}

function placeCaretInside(node) {
  if (!node) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(true);
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
  savedEditorRange = range.cloneRange();
}

function getInsertionMarker() {
  if (!els.postEditorBody || !insertionMarkerId) return null;
  return els.postEditorBody.querySelector(`[data-caret-marker="${insertionMarkerId}"]`);
}

function clearInsertionMarker() {
  const marker = getInsertionMarker();
  if (!marker) {
    insertionMarkerId = null;
    return;
  }
  const parent = marker.parentElement;
  marker.remove();
  insertionMarkerId = null;
  if (parent && parent.tagName === 'P' && !parent.textContent.trim() && !parent.querySelector('img,video,iframe,figure')) {
    parent.innerHTML = '<br>';
  }
}

function setInsertionMarkerFromRange(sourceRange) {
  if (!els.postEditorBody || !sourceRange) return false;
  clearInsertionMarker();
  const range = sourceRange.cloneRange();
  range.collapse(true);
  insertionMarkerId = uid('caret');
  const marker = document.createElement('span');
  marker.className = 'editor-caret-marker';
  marker.setAttribute('data-caret-marker', insertionMarkerId);
  marker.textContent = '\u200b';
  range.insertNode(marker);
  const after = document.createRange();
  after.setStartAfter(marker);
  after.collapse(true);
  const selection = window.getSelection();
  if (selection) {
    selection.removeAllRanges();
    selection.addRange(after);
  }
  savedEditorRange = after.cloneRange();
  return true;
}

function placeInsertionMarker() {
  if (!els.postEditorBody) return false;
  const range = getEditorInsertionRange();
  if (!range) return false;
  return setInsertionMarkerFromRange(range);
}

function getRangeFromMarker() {
  const marker = getInsertionMarker();
  if (!marker) return null;
  const range = document.createRange();
  range.setStartBefore(marker);
  range.collapse(true);
  return range;
}

function getEditorInsertionRange() {
  if (!els.postEditorBody) return null;
  const selection = window.getSelection();
  if (selection && selection.rangeCount) {
    const current = selection.getRangeAt(0);
    if (els.postEditorBody.contains(current.commonAncestorContainer)) return current.cloneRange();
  }
  if (savedEditorRange && els.postEditorBody.contains(savedEditorRange.commonAncestorContainer)) {
    return savedEditorRange.cloneRange();
  }
  const fallback = document.createRange();
  fallback.selectNodeContents(els.postEditorBody);
  fallback.collapse(false);
  return fallback;
}

function isRangeAtEditorStart(range) {
  if (!els.postEditorBody || !range) return false;
  const probe = range.cloneRange();
  probe.collapse(true);
  const start = document.createRange();
  start.selectNodeContents(els.postEditorBody);
  start.collapse(true);
  return probe.compareBoundaryPoints(Range.START_TO_START, start) === 0;
}

function ensureEditorHasEditableBoundaries() {
  if (!els.postEditorBody) return;
  const body = els.postEditorBody;
  const hasContent = body.innerHTML.replace(/<br\s*\/?>(?=\s*$)/gi, '').trim();
  if (!hasContent) {
    body.innerHTML = '<p><br></p>';
    placeCaretInside(body.firstElementChild);
    return;
  }

  const children = Array.from(body.children);
  children.forEach((child) => {
    if (child.tagName === 'FIGURE' && child.classList.contains('editor-media-frame')) {
      const before = ensureMediaAdjacentSlot(child, 'before');
      const after = ensureMediaAdjacentSlot(child, 'after');
      if (before) before.classList.add('media-text-slot');
      if (after) after.classList.add('media-text-slot');
    }
  });

  if (!body.firstElementChild) {
    body.append(createEmptyEditorParagraph(body.ownerDocument));
  }

  if (body.firstElementChild?.tagName === 'FIGURE') {
    body.prepend(createEmptyEditorParagraph(body.ownerDocument));
  }
  if (body.lastElementChild?.tagName === 'FIGURE') {
    body.append(createEmptyEditorParagraph(body.ownerDocument));
  }

  Array.from(body.querySelectorAll('p.media-text-slot')).forEach((slot) => {
    const hasAdjacentFigure = slot.previousElementSibling?.tagName === 'FIGURE' || slot.nextElementSibling?.tagName === 'FIGURE';
    if (!hasAdjacentFigure) slot.classList.remove('media-text-slot');
  });
}

function cleanupEditorBoundarySlots() {
  if (!els.postEditorBody) return;
  const body = els.postEditorBody;
  Array.from(body.querySelectorAll('p.media-text-slot')).forEach((slot) => {
    const text = slot.textContent.replace(/​/g, '').trim();
    const hasMediaNear = slot.previousElementSibling?.tagName === 'FIGURE' || slot.nextElementSibling?.tagName === 'FIGURE';
    if (!hasMediaNear && !text) {
      slot.remove();
      return;
    }
    if (!text) slot.innerHTML = '<br>';
  });
  if (!body.firstElementChild) body.append(createEmptyEditorParagraph(body.ownerDocument));
}

function placeCaretAtStart(node) {
  if (!node) return;
  if (!node.firstChild) node.innerHTML = '<br>';
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(true);
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
  savedEditorRange = range.cloneRange();
}

function placeCaretAtEnd(node) {
  if (!node) return;
  if (!node.firstChild) node.innerHTML = '<br>';
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
  savedEditorRange = range.cloneRange();
}

function focusAroundMedia(figure, direction = 'after') {
  const slot = ensureMediaAdjacentSlot(figure, direction);
  if (!slot) return;
  if (!slot.textContent.replace(/​/g, '').trim()) slot.innerHTML = '<br>';
  placeCaretAtStart(slot);
  clearSelectedMediaElement();
}
function rememberEditorSelection() {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || !els.postEditorBody) return;
  const range = selection.getRangeAt(0);
  if (!els.postEditorBody.contains(range.commonAncestorContainer)) return;
  savedEditorRange = range.cloneRange();
}

function restoreEditorSelection() {
  if (!savedEditorRange) return;
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(savedEditorRange);
}

function focusPostBody() {
  if (!els.postEditorBody) return;
  els.postEditorBody.focus();
  restoreEditorSelection();
}

function syncSelectedMediaWidthUi() {
  if (!els.selectedMediaWidth) return;
  if (!selectedMediaElement) {
    els.selectedMediaWidth.value = '';
    return;
  }
  const target = selectedMediaElement.classList?.contains('editor-media-frame') ? selectedMediaElement : selectedMediaElement.closest('.editor-media-frame') || selectedMediaElement.closest('.embed-frame-wrap') || selectedMediaElement;
  els.selectedMediaWidth.value = target?.style.width || '100%';
}

function selectMediaElement(target) {
  if (!target) return;
  document.querySelectorAll('.editor-media-selected').forEach((el) => el.classList.remove('editor-media-selected'));
  selectedMediaElement = target.classList?.contains('editor-media-frame') ? target : target.closest('.editor-media-frame') || target.closest('.embed-frame-wrap') || target;
  selectedMediaElement.classList.add('editor-media-selected');
  syncSelectedMediaWidthUi();
}

function clearSelectedMediaElement() {
  document.querySelectorAll('.editor-media-selected').forEach((el) => el.classList.remove('editor-media-selected'));
  selectedMediaElement = null;
  syncSelectedMediaWidthUi();
}

function buildVideoPlaceholder(sourceUrl) {
  const safe = escapeHtml(sourceUrl || '');
  return `<div class="video-editor-placeholder" data-video-source="${safe}"><div class="video-editor-placeholder-inner"><strong>동영상</strong><span>편집 중에는 미리보기 없이 크기만 조절됩니다.</span></div></div>`;
}

function buildMediaHtml(type, source, width = '100%', mode = 'editor') {
  const safeWidth = escapeHtml(width || '100%');
  const sourceUrl = String(source || '').trim();
  if (type === 'image') {
    return `<figure class="editor-media-frame media-sharp" draggable="true" contenteditable="false" data-media-type="image" style="width:${safeWidth};max-width:100%;margin:10px 0;"><img class="editor-inline-media media-sharp" src="${escapeHtml(sourceUrl)}" alt="image" referrerpolicy="no-referrer" loading="lazy" draggable="false" /><span class="media-resize-handle" title="드래그해서 크기 조절"></span></figure>`;
  }
  if (mode === 'editor') {
    return `<figure class="editor-media-frame media-sharp video-placeholder-frame" draggable="true" contenteditable="false" data-media-type="video" data-media-source="${escapeHtml(sourceUrl)}" style="width:${safeWidth};max-width:100%;margin:10px 0;">${buildVideoPlaceholder(sourceUrl)}<span class="media-resize-handle" title="드래그해서 크기 조절"></span></figure>`;
  }
  const normalized = normalizeYoutubeUrl(sourceUrl);
  if (normalized.includes('youtube.com/embed/')) {
    return `<figure class="editor-media-frame media-sharp embed-frame-wrap" draggable="true" contenteditable="false" data-media-type="video" data-media-source="${escapeHtml(sourceUrl)}" style="width:${safeWidth};max-width:100%;margin:10px 0;"><iframe class="editor-inline-media" src="${escapeHtml(normalized)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe></figure>`;
  }
  return `<figure class="editor-media-frame media-sharp" draggable="true" contenteditable="false" data-media-type="video" data-media-source="${escapeHtml(sourceUrl)}" style="width:${safeWidth};max-width:100%;margin:10px 0;"><video class="editor-inline-media media-sharp" controls preload="metadata" src="${escapeHtml(sourceUrl)}"></video></figure>`;
}

function storageToEditorHtml(html) {
  const doc = createHtmlDocument(html);
  doc.querySelectorAll('figure.editor-media-frame[data-media-type="video"]').forEach((figure) => {
    const source = figure.getAttribute('data-media-source') || figure.querySelector('iframe')?.getAttribute('src') || figure.querySelector('video')?.getAttribute('src') || '';
    figure.setAttribute('data-media-source', source);
    figure.classList.add('video-placeholder-frame');
    figure.innerHTML = `${buildVideoPlaceholder(source)}<span class="media-resize-handle" title="드래그해서 크기 조절"></span>`;
  });
  return doc.getElementById('root')?.innerHTML || '';
}

function editorToStorageHtml(html) {
  const doc = createHtmlDocument(html);
  doc.querySelectorAll('p.media-text-slot').forEach((slot) => {
    const text = slot.textContent.replace(/​/g, '').trim();
    if (!text) {
      slot.remove();
      return;
    }
    slot.classList.remove('media-text-slot');
    slot.removeAttribute('data-slot-type');
  });
  doc.querySelectorAll('figure.editor-media-frame[data-media-type="video"]').forEach((figure) => {
    const width = figure.style.width || figure.dataset.width || '100%';
    const source = figure.getAttribute('data-media-source') || figure.querySelector('[data-video-source]')?.getAttribute('data-video-source') || '';
    const replacement = buildMediaHtml('video', source, width, 'storage');
    const wrap = doc.createElement('div');
    wrap.innerHTML = replacement;
    figure.replaceWith(wrap.firstElementChild);
  });
  return doc.getElementById('root')?.innerHTML || '';
}

function insertHtmlAtCaret(html) {
  if (!els.postEditorBody) return;
  focusPostBody();
  const range = getRangeFromMarker() || getEditorInsertionRange();
  if (!range) return;
  clearInsertionMarker();
  const selection = window.getSelection();
  if (selection) {
    selection.removeAllRanges();
    selection.addRange(range);
  }
  const trailingId = uid('after');
  const markup = `${html}<p><span data-after-insert="${trailingId}"></span><br></p>`;
  document.execCommand('insertHTML', false, markup);
  ensureEditorHasEditableBoundaries();
  const afterMarker = els.postEditorBody.querySelector(`[data-after-insert="${trailingId}"]`);
  if (afterMarker) {
    const nextParagraph = afterMarker.closest('p');
    const nextRange = document.createRange();
    if (nextParagraph) {
      nextRange.selectNodeContents(nextParagraph);
      nextRange.collapse(true);
    } else {
      nextRange.setStartAfter(afterMarker);
      nextRange.collapse(true);
    }
    const nextSelection = window.getSelection();
    if (nextSelection) {
      nextSelection.removeAllRanges();
      nextSelection.addRange(nextRange);
    }
    afterMarker.remove();
    savedEditorRange = nextRange.cloneRange();
  } else {
    rememberEditorSelection();
  }
}

function resolveDropRangeFromPoint(clientX, clientY, mediaEl = null) {
  if (!els.postEditorBody) return null;
  let pointRange = document.caretRangeFromPoint ? document.caretRangeFromPoint(clientX, clientY) : null;
  const pointed = document.elementFromPoint(clientX, clientY);
  const figure = pointed?.closest?.('.editor-media-frame');
  if (figure) {
    const rect = figure.getBoundingClientRect();
    const direction = clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    const slot = ensureMediaAdjacentSlot(figure, direction);
    const range = document.createRange();
    range.selectNodeContents(slot);
    range.collapse(direction === 'before');
    return range;
  }
  if (pointRange && mediaEl && mediaEl.contains(pointRange.startContainer)) {
    const fallbackSlot = ensureMediaAdjacentSlot(mediaEl, clientY < mediaEl.getBoundingClientRect().top + mediaEl.getBoundingClientRect().height / 2 ? 'before' : 'after');
    const range = document.createRange();
    range.selectNodeContents(fallbackSlot);
    range.collapse(false);
    return range;
  }
  if (pointRange && els.postEditorBody.contains(pointRange.commonAncestorContainer)) return pointRange;
  const fallback = document.createRange();
  fallback.selectNodeContents(els.postEditorBody);
  fallback.collapse(false);
  return fallback;
}

function insertExistingMediaAtPoint(mediaEl, pointRange) {
  if (!els.postEditorBody || !mediaEl || !pointRange) return;
  const html = mediaEl.outerHTML;
  const previous = getMediaAdjacentSlot(mediaEl, 'before');
  const next = getMediaAdjacentSlot(mediaEl, 'after');
  mediaEl.remove();
  if (previous && !previous.textContent.replace(/​/g, '').trim()) previous.remove();
  if (next && !next.textContent.replace(/​/g, '').trim()) next.remove();
  if (!setInsertionMarkerFromRange(pointRange)) return;
  insertHtmlAtCaret(html);
  ensureEditorHasEditableBoundaries();
  cleanupEditorBoundarySlots();
}

function openInsertPanel(type) {
  rememberEditorSelection();
  placeInsertionMarker();
  state.ui.mediaInsertType = type;
  if (els.editorInsertTitle) els.editorInsertTitle.textContent = type === 'image' ? '이미지 삽입' : '동영상 삽입';
  if (els.mediaInsertUrl) els.mediaInsertUrl.value = '';
  if (els.mediaFileInput) els.mediaFileInput.value = '';
  els.editorInsertPanel?.classList.remove('hidden');
  focusPostBody();
}

function closeInsertPanel() {
  els.editorInsertPanel?.classList.add('hidden');
  clearInsertionMarker();
}

function insertMediaByUrl() {
  const type = state.ui.mediaInsertType || 'image';
  const value = els.mediaInsertUrl?.value?.trim() || '';
  if (!value) {
    showToast('링크를 입력해주세요.', 'error');
    return;
  }
  insertHtmlAtCaret(buildMediaHtml(type, value));
  closeInsertPanel();
  showToast(type === 'image' ? '이미지를 삽입했습니다.' : '동영상을 삽입했습니다.', 'success');
}

async function insertMediaFile(file) {
  if (!file) return;
  const type = state.ui.mediaInsertType || 'image';
  if (type === 'image' && !file.type.startsWith('image/')) {
    showToast('이미지 파일만 첨부할 수 있습니다.', 'error');
    return;
  }
  if (type === 'video' && !file.type.startsWith('video/')) {
    showToast('영상 파일만 첨부할 수 있습니다.', 'error');
    return;
  }
  try {
    showToast(isRemoteModeEnabled() ? '파일을 업로드하는 중입니다...' : '파일을 불러오는 중입니다...', 'success');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    let src = '';
    if (isRemoteModeEnabled()) {
      const admin = getCurrentAdmin();
      if (!admin) {
        showToast('공용 운영 모드에서는 관리자만 파일 업로드가 가능합니다.', 'error');
        return;
      }
      const uploaded = await uploadGuidebookMedia(file, admin.id);
      if (uploaded.error || !uploaded.data?.publicUrl) throw uploaded.error || new Error('upload_failed');
      src = uploaded.data.publicUrl;
    } else {
      src = await readFileAsDataUrl(file);
    }
    insertHtmlAtCaret(buildMediaHtml(type, src));
    closeInsertPanel();
    showToast('파일을 삽입했습니다.', 'success');
  } catch {
    showToast('파일을 불러오지 못했습니다.', 'error');
  }
}

function applyFormatToBody(command, value = null) {
  focusPostBody();
  document.execCommand(command, false, value);
  rememberEditorSelection();
}

function applySelectedMediaWidth() {
  if (!selectedMediaElement || !els.selectedMediaWidth) return;
  const nextWidth = els.selectedMediaWidth.value.trim() || '100%';
  const target = selectedMediaElement.classList?.contains('editor-media-frame') ? selectedMediaElement : selectedMediaElement.closest('.editor-media-frame') || selectedMediaElement.closest('.embed-frame-wrap') || selectedMediaElement;
  if (target) target.style.width = nextWidth;
  syncSelectedMediaWidthUi();
}

function initMediaResizing() {
  let resizeState = null;

  const stopResize = () => {
    if (!resizeState) return;
    document.body.classList.remove('resizing-media');
    resizeState = null;
  };

  document.addEventListener('mousemove', (event) => {
    if (!resizeState) return;
    event.preventDefault();
    const delta = event.clientX - resizeState.startX;
    const nextWidth = Math.max(resizeState.minWidth, resizeState.startWidth + delta);
    const maxWidth = resizeState.maxWidth || nextWidth;
    const clamped = Math.min(maxWidth, nextWidth);
    resizeState.target.style.width = `${Math.round(clamped)}px`;
    resizeState.target.dataset.width = `${Math.round(clamped)}px`;
    selectMediaElement(resizeState.target);
  });

  document.addEventListener('mouseup', stopResize);
  document.addEventListener('mouseleave', stopResize);

  els.postEditorBody?.addEventListener('mousedown', (event) => {
    const handle = event.target.closest('.media-resize-handle');
    if (!handle) return;
    const target = handle.closest('.editor-media-frame');
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    const editorRect = els.postEditorBody.getBoundingClientRect();
    resizeState = {
      target,
      startX: event.clientX,
      startWidth: target.getBoundingClientRect().width,
      minWidth: 120,
      maxWidth: Math.max(160, editorRect.width - 16),
    };
    document.body.classList.add('resizing-media');
    selectMediaElement(target);
  });
}

function startNewPost(prefill = null) {
  state.ui.editingPostId = null;
  state.postDraft = {
    id: uid('post'),
    categoryId: state.data.categories[0]?.id || '',
    title: prefill?.title || '',
    titleHtml: prefill?.titleHtml || escapeHtml(prefill?.title || ''),
    summary: prefill?.summary || '',
    aliases: prefill?.aliases || [],
    titleStyle: {
      color: prefill?.titleStyle?.color || '#162033',
      fontSize: prefill?.titleStyle?.fontSize || '18px',
      fontWeight: prefill?.titleStyle?.fontWeight || '700',
      fontStyle: prefill?.titleStyle?.fontStyle || 'normal',
    },
    contentHtml: prefill?.contentHtml || postContentHtmlFromPost(prefill) || '',
    blocks: prefill?.blocks?.length ? clone(prefill.blocks) : [{ id: uid('block'), type: 'text', text: '' }],
    createdAt: now(),
    updatedAt: now(),
    isPublished: true,
  };
  renderPostEditor();
}

function openPostEditor(postId) {
  const post = getPostById(postId);
  if (!post) return;
  state.ui.editingPostId = postId;
  state.postDraft = clone(post);
  if (!state.postDraft.titleHtml) state.postDraft.titleHtml = escapeHtml(state.postDraft.title || '');
  if (!state.postDraft.contentHtml) state.postDraft.contentHtml = postContentHtmlFromPost(state.postDraft);
  renderPostEditor();
}

function syncPostDraftFromForm() {
  if (!state.postDraft) return;
  state.postDraft.categoryId = els.postEditorCategory.value;
  state.postDraft.titleHtml = normalizeTitleHtml(els.postEditorTitleRich?.innerHTML || '');
  state.postDraft.title = stripHtml(state.postDraft.titleHtml) || '';
  state.postDraft.summary = els.postEditorSummary.value.trim();
  state.postDraft.contentHtml = editorToStorageHtml(normalizeEditorHtml(els.postEditorBody?.innerHTML || ''));
  state.postDraft.titleStyle = {
    color: '#162033',
    fontSize: '18px',
    fontWeight: '700',
    fontStyle: 'normal',
  };
  const aliasBase = [state.postDraft.title.replace(/\s+/g, ''), getCategoryById(state.postDraft.categoryId)?.name || ''];
  state.postDraft.aliases = Array.from(new Set(aliasBase.filter(Boolean)));
  state.postDraft.blocks = [{ id: uid('block'), type: 'text', html: state.postDraft.contentHtml, text: stripHtml(state.postDraft.contentHtml) }];
}

function renderPostEditor() {
  const categoriesHtml = getSortedCategories({ includeHidden: true }).map((category) => `<option value="${category.id}">${category.name}${category.hidden ? ' (숨김)' : ''}</option>`).join('');
  els.postEditorCategory.innerHTML = categoriesHtml;
  const hasDraft = Boolean(state.postDraft);
  els.postEditorForm.classList.toggle('hidden', !hasDraft);
  els.postEditorEmpty.classList.toggle('hidden', hasDraft);
  if (!hasDraft) return;

  const draft = state.postDraft;
  els.postEditorCategory.value = draft.categoryId;
  els.postEditorTitleRich.innerHTML = brightenDarkInlineColors(draft.titleHtml || escapeHtml(draft.title || ''));
  els.postEditorSummary.value = draft.summary || '';
  els.postEditorTitleColor.value = '#162033';
  els.postEditorBody.innerHTML = brightenDarkInlineColors(storageToEditorHtml(draft.contentHtml || postContentHtmlFromPost(draft) || ''));
  ensureEditorHasEditableBoundaries();
  els.deletePostButton.classList.toggle('hidden', !state.ui.editingPostId);
  closeInsertPanel();
  clearSelectedMediaElement();
  setInlineMessage(els.postEditorMessage, '');
}

function applyFormatToTitle(command, value = null) {
  if (!els.postEditorTitleRich) return;
  els.postEditorTitleRich.focus();
  document.execCommand(command, false, value);
}

function renderDraftPreview() {
  if (!state.postDraft) return;
  syncPostDraftFromForm();
  state.ui.previewingDraft = true;
  navigate('post', { postId: '__draft__' });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function savePostDraft() {
  syncPostDraftFromForm();
  const draft = state.postDraft;
  if (!draft.title) {
    setInlineMessage(els.postEditorMessage, '게시글 제목을 입력해주세요.', 'error');
    return;
  }
  if (!hasMeaningfulEditorContent(draft.contentHtml)) {
    setInlineMessage(els.postEditorMessage, '본문 내용을 입력해주세요.', 'error');
    return;
  }
  if (!(await syncLatestSharedData())) {
    setInlineMessage(els.postEditorMessage, '공용 데이터 동기화에 실패했습니다. 다시 시도해주세요.', 'error');
    return;
  }
  draft.updatedAt = now();
  if (state.ui.editingPostId) {
    const index = state.data.posts.findIndex((post) => post.id === state.ui.editingPostId);
    state.data.posts[index] = clone(draft);
    logAction(`게시글 수정: ${draft.title}`, { persist: false });
  } else {
    state.data.posts.unshift(clone(draft));
    logAction(`게시글 생성: ${draft.title}`, { persist: false });
    state.ui.editingPostId = draft.id;
  }
  await saveData();
  renderAdminView();
  showToast('게시글이 저장되었습니다.', 'success');
}
async function deleteCurrentPost() {
  if (!state.ui.editingPostId) return;
  if (!(await syncLatestSharedData())) {
    showToast('공용 데이터 동기화에 실패했습니다. 다시 시도해주세요.', 'error');
    return;
  }
  const post = getPostById(state.ui.editingPostId);
  state.data.posts = state.data.posts.filter((item) => item.id !== state.ui.editingPostId);
  logAction(`게시글 삭제: ${post?.title || '-'}`, { persist: false });
  await saveData();
  state.ui.editingPostId = null;
  state.postDraft = null;
  renderAdminView();
  showToast('게시글을 삭제했습니다.', 'success');
}

function openNoticeEditor(noticeId) {
  const notice = getNoticeById(noticeId);
  if (!notice) return;
  state.ui.editingNoticeId = noticeId;
  state.noticeDraft = clone(notice);
  renderNoticeEditor();
}

function startNewNotice() {
  state.ui.editingNoticeId = null;
  state.noticeDraft = { id: uid('notice'), title: '', content: '', createdAt: now(), updatedAt: now() };
  renderNoticeEditor();
}

function renderNoticeEditor() {
  const hasDraft = Boolean(state.noticeDraft);
  els.noticeEditorForm.classList.toggle('hidden', !hasDraft);
  els.noticeEditorEmpty.classList.toggle('hidden', hasDraft);
  if (!hasDraft) return;
  els.noticeEditorTitle.value = state.noticeDraft.title || '';
  els.noticeEditorContent.value = state.noticeDraft.content || '';
  els.deleteNoticeButton.classList.toggle('hidden', !state.ui.editingNoticeId);
  setInlineMessage(els.noticeEditorMessage, '');
}

async function saveNoticeDraft() {
  if (!state.noticeDraft) return;
  state.noticeDraft.title = els.noticeEditorTitle.value.trim();
  state.noticeDraft.content = els.noticeEditorContent.value.trim();
  if (!state.noticeDraft.title || !state.noticeDraft.content) {
    setInlineMessage(els.noticeEditorMessage, '제목과 내용을 모두 입력해주세요.', 'error');
    return;
  }
  if (!(await syncLatestSharedData())) {
    setInlineMessage(els.noticeEditorMessage, '공용 데이터 동기화에 실패했습니다. 다시 시도해주세요.', 'error');
    return;
  }
  state.noticeDraft.updatedAt = now();
  if (state.ui.editingNoticeId) {
    const index = state.data.notices.findIndex((item) => item.id === state.ui.editingNoticeId);
    state.data.notices[index] = clone(state.noticeDraft);
    logAction(`공지 수정: ${state.noticeDraft.title}`, { persist: false });
  } else {
    state.data.notices.unshift(clone(state.noticeDraft));
    logAction(`공지 생성: ${state.noticeDraft.title}`, { persist: false });
    state.ui.editingNoticeId = state.noticeDraft.id;
  }
  await saveData();
  renderAdminView();
  showToast('공지가 저장되었습니다.', 'success');
}

async function deleteCurrentNotice() {
  if (!state.ui.editingNoticeId) return;
  if (!(await syncLatestSharedData())) {
    showToast('공용 데이터 동기화에 실패했습니다. 다시 시도해주세요.', 'error');
    return;
  }
  const notice = getNoticeById(state.ui.editingNoticeId);
  state.data.notices = state.data.notices.filter((item) => item.id !== state.ui.editingNoticeId);
  logAction(`공지 삭제: ${notice?.title || '-'}`, { persist: false });
  await saveData();
  state.ui.editingNoticeId = null;
  state.noticeDraft = null;
  renderAdminView();
  showToast('공지를 삭제했습니다.', 'success');
}

function renderAdminAccountEditor() {
  const admin = getCurrentAdmin();
  const targetId = state.ui.selectedAdminId || admin?.id;
  const target = getAdminById(targetId);
  const canCreate = isSuperAdmin(admin);

  els.adminCreateForm.classList.add('hidden');
  els.adminColorForm.classList.toggle('hidden', !target);
  els.adminPasswordForm.classList.toggle('hidden', !target);
  els.adminAccountEmpty.classList.toggle('hidden', Boolean(target));
  if (!target) return;

  const targetLabel = `${target.nickname}${target.lastLoginIp ? `(${target.lastLoginIp})` : ''}`;
  const isSelf = Boolean(admin && admin.id === target.id);
  const canEditColor = Boolean(admin && (admin.id === target.id || isSuperAdmin(admin)));
  const canEditPassword = isRemoteModeEnabled() ? isSelf : canEditColor;

  els.adminColorTargetName.textContent = targetLabel;
  els.adminColorInput.value = target.color || '#3a7bff';
  els.adminColorInput.disabled = !canEditColor;
  els.adminColorForm.querySelector('button[type="submit"]').disabled = !canEditColor;

  els.adminPasswordTargetName.textContent = targetLabel;
  els.adminPasswordHint.textContent = isRemoteModeEnabled()
    ? (isSelf ? '본인 계정 비밀번호를 Supabase Auth 기준으로 변경합니다. 현재 비밀번호 확인이 필요합니다.' : '다른 관리자 비밀번호 재설정은 Supabase 대시보드에서 처리해야 합니다.')
    : (isSelf ? '본인 계정 비밀번호를 변경합니다. 현재 비밀번호 확인이 필요합니다.' : (canEditPassword ? '슈퍼관리자는 다른 관리자 비밀번호를 재설정할 수 있습니다.' : '본인 계정만 비밀번호를 변경할 수 있습니다.'));
  els.adminCurrentPassword.disabled = !canEditPassword || !isSelf;
  els.adminCurrentPassword.placeholder = isSelf ? '현재 비밀번호 입력' : (isRemoteModeEnabled() ? '대시보드에서 재설정' : '슈퍼관리자 재설정에서는 생략');
  els.adminNewPassword.disabled = !canEditPassword;
  els.adminNewPasswordConfirm.disabled = !canEditPassword;
  els.adminPasswordForm.querySelector('button[type="submit"]').disabled = !canEditPassword;
  [els.adminCurrentPassword, els.adminNewPassword, els.adminNewPasswordConfirm].forEach((input) => {
    input.value = '';
  });

  els.deleteAdminButton.classList.toggle('hidden', !(canCreate && target.id !== admin.id));
  if (els.deleteAdminButton) els.deleteAdminButton.textContent = isRemoteModeEnabled() ? '계정 비활성화' : '계정 삭제';
  els.openAdminCreateButton.classList.toggle('hidden', !canCreate);
  setInlineMessage(els.adminColorMessage, canEditColor ? '' : '본인 색상만 수정할 수 있습니다.', canEditColor ? '' : 'error');
  setInlineMessage(els.adminPasswordMessage, canEditPassword ? '' : '본인 계정만 비밀번호를 변경할 수 있습니다.', canEditPassword ? '' : 'error');
}

function openAdminCreateForm() {
  if (!isSuperAdmin()) return;
  if (isRemoteModeEnabled()) {
    els.adminCreateForm.classList.remove('hidden');
    els.adminAccountEmpty.classList.add('hidden');
    els.adminColorForm.classList.add('hidden');
    setInlineMessage(els.adminCreateMessage, '다중 사용자 운영판에서는 Supabase Auth 대시보드에서 이메일 계정을 만든 뒤 admin profile 행을 추가하세요.', 'success');
    return;
  }
  els.adminCreateForm.classList.remove('hidden');
  els.adminAccountEmpty.classList.add('hidden');
  els.adminColorForm.classList.add('hidden');
  [els.adminCreateNickname, els.adminCreateUsername, els.adminCreatePassword, els.adminCreatePasswordConfirm].forEach((input) => input.value = '');
  setInlineMessage(els.adminCreateMessage, '');
}

function closeAdminCreateForm() {
  els.adminCreateForm.classList.add('hidden');
  renderAdminAccountEditor();
}

function createAdminAccount() {
  if (!isSuperAdmin()) return;
  if (isRemoteModeEnabled()) {
    setInlineMessage(els.adminCreateMessage, '이 버전에서는 관리자 생성은 Supabase Auth 대시보드 + SQL 프로필 추가로 처리합니다.', 'error');
    return;
  }
  const nickname = els.adminCreateNickname.value.trim();
  const username = els.adminCreateUsername.value.trim();
  const password = els.adminCreatePassword.value;
  const confirm = els.adminCreatePasswordConfirm.value;

  if (!validateAdminNickname(nickname)) {
    setInlineMessage(els.adminCreateMessage, '닉네임은 한글/영문/숫자/밑줄 2~16자만 가능합니다.', 'error');
    return;
  }
  if (!validateAdminUsername(username)) {
    setInlineMessage(els.adminCreateMessage, '아이디는 영문/숫자/밑줄 4~20자만 가능합니다.', 'error');
    return;
  }
  if (!password || password.length < 4) {
    setInlineMessage(els.adminCreateMessage, '비밀번호는 최소 4자 이상 입력해주세요.', 'error');
    return;
  }
  if (password !== confirm) {
    setInlineMessage(els.adminCreateMessage, '비밀번호 확인이 일치하지 않습니다.', 'error');
    return;
  }
  if (state.data.admins.some((item) => item.username === username && !item.disabled)) {
    setInlineMessage(els.adminCreateMessage, '이미 사용 중인 관리자 아이디입니다.', 'error');
    return;
  }

  state.data.admins.push({
    id: uid('admin'),
    nickname,
    username,
    password,
    color: '#8a63ff',
    isSuperAdmin: false,
    disabled: false,
    createdAt: now(),
    createdBy: getCurrentAdmin()?.username || 'system',
    lastLoginIp: '',
    lastLoginAt: '',
  });
  saveData();
  logAction(`관리자 계정 생성: ${nickname}`);
  closeAdminCreateForm();
  renderAdminView();
  showToast('관리자 계정을 생성했습니다.', 'success');
}

async function saveAdminColor() {
  const admin = getCurrentAdmin();
  const target = getAdminById(state.ui.selectedAdminId || admin?.id);
  if (!target || !admin) return;
  if (!(admin.id === target.id || isSuperAdmin(admin))) {
    setInlineMessage(els.adminColorMessage, '본인 색상만 수정할 수 있습니다.', 'error');
    return;
  }
  target.color = els.adminColorInput.value;
  if (isRemoteModeEnabled()) {
    const { error } = await updateAdminProfile(target.id, { color: target.color });
    if (error) {
      setInlineMessage(els.adminColorMessage, '공용 관리자 프로필 저장에 실패했습니다.', 'error');
      return;
    }
    await refreshRemoteSnapshot({ render: false, includePresence: false });
    logAction(`관리자 색상 변경: ${target.nickname}`, { persist: false });
    await saveData();
  } else {
    await saveData();
    logAction(`관리자 색상 변경: ${target.nickname}`);
  }
  renderAdminView();
  showToast('관리자 표시 색상을 저장했습니다.', 'success');
}

async function saveAdminPassword() {
  const admin = getCurrentAdmin();
  const target = getAdminById(state.ui.selectedAdminId || admin?.id);
  if (!target || !admin) return;
  const canEditPassword = admin.id === target.id || isSuperAdmin(admin);
  const isSelf = admin.id === target.id;
  if (!canEditPassword) {
    setInlineMessage(els.adminPasswordMessage, '본인 계정만 비밀번호를 변경할 수 있습니다.', 'error');
    return;
  }

  const currentPassword = els.adminCurrentPassword.value;
  const newPassword = els.adminNewPassword.value;
  const confirmPassword = els.adminNewPasswordConfirm.value;

  if (!newPassword || newPassword.length < 4) {
    setInlineMessage(els.adminPasswordMessage, '새 비밀번호는 최소 4자 이상 입력해주세요.', 'error');
    return;
  }
  if (newPassword !== confirmPassword) {
    setInlineMessage(els.adminPasswordMessage, '새 비밀번호 확인이 일치하지 않습니다.', 'error');
    return;
  }

  if (isRemoteModeEnabled()) {
    if (!isSelf) {
      setInlineMessage(els.adminPasswordMessage, '다중 사용자 운영판에서는 다른 관리자 비밀번호 재설정을 Supabase 대시보드에서 처리해야 합니다.', 'error');
      return;
    }
    const { error: authError } = await signInAdmin(admin.email, currentPassword);
    if (authError) {
      setInlineMessage(els.adminPasswordMessage, '현재 비밀번호가 올바르지 않습니다.', 'error');
      return;
    }
    const { error } = await updateOwnAdminPassword(newPassword);
    if (error) {
      setInlineMessage(els.adminPasswordMessage, '비밀번호 변경에 실패했습니다.', 'error');
      return;
    }
    logAction(`관리자 비밀번호 변경: ${target.nickname}`, { persist: false });
    await saveData();
    renderAdminView();
    showToast('비밀번호를 변경했습니다.', 'success');
    return;
  }

  if (isSelf && currentPassword !== target.password) {
    setInlineMessage(els.adminPasswordMessage, '현재 비밀번호가 올바르지 않습니다.', 'error');
    return;
  }
  if (newPassword === target.password) {
    setInlineMessage(els.adminPasswordMessage, '기존과 다른 비밀번호를 입력해주세요.', 'error');
    return;
  }

  target.password = newPassword;
  await saveData();
  logAction(`관리자 비밀번호 변경: ${target.nickname}`);
  renderAdminView();
  showToast(isSelf ? '비밀번호를 변경했습니다.' : '선택한 관리자 비밀번호를 재설정했습니다.', 'success');
}

async function deleteSelectedAdmin() {
  const admin = getCurrentAdmin();
  const target = getAdminById(state.ui.selectedAdminId);
  if (!admin || !target || !isSuperAdmin(admin) || target.id === admin.id) return;
  if (isRemoteModeEnabled()) {
    const { error } = await updateAdminProfile(target.id, { disabled: true });
    if (error) {
      showToast('관리자 비활성화에 실패했습니다.', 'error');
      return;
    }
    await refreshRemoteSnapshot({ render: false, includePresence: false });
    logAction(`관리자 계정 삭제: ${target.nickname}`, { persist: false });
    await saveData();
  } else {
    target.disabled = true;
    await saveData();
    logAction(`관리자 계정 삭제: ${target.nickname}`);
  }
  if (state.session.adminId === target.id) {
    state.session.adminId = null;
    saveSession();
    updateViewerLabels();
    navigate('launcher', {}, false);
    showToast('해당계정이 운영자에 의해 삭제되었습니다.', 'error');
  } else {
    state.ui.selectedAdminId = admin.id;
    renderAdminView();
    showToast(isRemoteModeEnabled() ? '관리자 계정을 비활성화했습니다.' : '관리자 계정을 삭제했습니다.', 'success');
  }
}

function ensureAdminSessionValid() {
  if (!state.session.adminId) return true;
  const admin = getCurrentAdmin();
  if (admin) return true;
  state.session.adminId = null;
  saveSession();
  updateViewerLabels();
  showToast('해당계정이 운영자에 의해 삭제되었습니다.', 'error');
  navigate('launcher', {}, false);
  return false;
}

function getAdminLockState() {
  try {
    return JSON.parse(localStorage.getItem(ADMIN_LOCK_KEY) || '{"failCount":0,"lockedUntil":0}');
  } catch {
    return { failCount: 0, lockedUntil: 0 };
  }
}

function setAdminLockState(value) {
  localStorage.setItem(ADMIN_LOCK_KEY, JSON.stringify(value));
}

function clearAdminLockState() {
  setAdminLockState({ failCount: 0, lockedUntil: 0 });
}

function recordAdminLoginFailure() {
  const current = getAdminLockState();
  const nextCount = (current.failCount || 0) + 1;
  if (nextCount >= ADMIN_LOCK_FAIL_LIMIT) {
    const lockedUntil = Date.now() + ADMIN_LOCK_MS;
    setAdminLockState({ failCount: 0, lockedUntil });
    return { locked: true, lockedUntil };
  }
  setAdminLockState({ failCount: nextCount, lockedUntil: 0 });
  return { locked: false, failCount: nextCount };
}

function getAdminLockRemainingMs() {
  const current = getAdminLockState();
  const remaining = (current.lockedUntil || 0) - Date.now();
  if (remaining <= 0 && current.lockedUntil) clearAdminLockState();
  return Math.max(0, remaining);
}

async function loginAdmin() {
  const remaining = getAdminLockRemainingMs();
  if (remaining > 0) {
    const seconds = Math.ceil(remaining / 1000);
    setInlineMessage(els.adminLoginMessage, `로그인 실패가 많아 ${seconds}초 후 다시 시도할 수 있습니다.`, 'error');
    return;
  }
  const username = els.adminLoginId.value.trim();
  const password = els.adminLoginPassword.value;

  if (isRemoteModeEnabled()) {
    const { data, error } = await signInAdmin(username, password);
    if (error || !data?.user) {
      const result = recordAdminLoginFailure();
      if (result.locked) {
        setInlineMessage(els.adminLoginMessage, '비밀번호를 5회 잘못 입력했습니다. 1분 동안 ADMIN 로그인이 잠깁니다.', 'error');
      } else {
        setInlineMessage(els.adminLoginMessage, `이메일 또는 비밀번호가 올바르지 않습니다. (${result.failCount}/${ADMIN_LOCK_FAIL_LIMIT})`, 'error');
      }
      return;
    }
    await refreshRemoteSnapshot({ render: false, includePresence: false });
    const admin = state.data.admins.find((item) => !item.disabled && item.id === data.user.id);
    if (!admin) {
      await signOutAdminRemote();
      setInlineMessage(els.adminLoginMessage, '관리자 프로필이 없거나 비활성화되어 있습니다.', 'error');
      return;
    }
    clearAdminLockState();
    await updateAdminProfile(admin.id, { last_login_ip: state.session.currentIp, last_login_at: now(), email: data.user.email || admin.email || username });
    await refreshRemoteSnapshot({ render: false, includePresence: false });
    state.session.adminId = admin.id;
    state.session.rememberAdminUsername = Boolean(els.adminRememberId?.checked);
    state.session.rememberedAdminUsername = state.session.rememberAdminUsername ? username : '';
    await persistPresence();
    saveSession();
    logAction(`관리자 로그인: ${admin.nickname}`, { persist: false });
    await saveData();
    updateViewerLabels();
    state.ui.selectedAdminId = admin.id;
    state.ui.activeAdminTab = 'overview';
    enterGuideHome();
    showToast('관리자 로그인 완료', 'success');
    return;
  }

  const admin = state.data.admins.find((item) => !item.disabled && item.username === username && item.password === password);
  if (!admin) {
    const result = recordAdminLoginFailure();
    if (result.locked) {
      setInlineMessage(els.adminLoginMessage, '비밀번호를 5회 잘못 입력했습니다. 1분 동안 ADMIN 로그인이 잠깁니다.', 'error');
    } else {
      setInlineMessage(els.adminLoginMessage, `아이디 또는 비밀번호가 올바르지 않습니다. (${result.failCount}/${ADMIN_LOCK_FAIL_LIMIT})`, 'error');
    }
    return;
  }
  clearAdminLockState();
  admin.lastLoginIp = state.session.currentIp;
  admin.lastLoginAt = now();
  state.session.adminId = admin.id;
  removeCurrentDeviceUserPresence();
  state.session.rememberAdminUsername = Boolean(els.adminRememberId?.checked);
  state.session.rememberedAdminUsername = state.session.rememberAdminUsername ? username : '';
  upsertKnownUser({ nickname: admin.nickname, isAdmin: true, adminId: admin.id });
  await saveData();
  saveSession();
  logAction(`관리자 로그인: ${admin.nickname}`);
  updateViewerLabels();
  state.ui.selectedAdminId = admin.id;
  state.ui.activeAdminTab = 'overview';
  enterGuideHome();
  showToast('관리자 로그인 완료', 'success');
  if (isUsingDefaultSuperAdmin()) {
    showToast('기본 관리자 비밀번호가 그대로입니다. 운영 전 반드시 변경하세요.', 'error');
  }
}

async function logoutAdmin() {
  const admin = getCurrentAdmin();
  state.session.adminId = null;
  if (!state.session.rememberAdminUsername) {
    state.session.rememberedAdminUsername = '';
  }
  if (isRemoteModeEnabled()) {
    await clearPresenceRecord();
    await signOutAdminRemote();
  }
  saveSession();
  if (els.adminLoginId) { els.adminLoginId.value = state.session.rememberedAdminUsername || ''; els.adminLoginId.setAttribute('autocomplete', 'off'); els.adminLoginId.placeholder = isRemoteModeEnabled() ? 'admin@example.com' : ''; }
  if (els.adminLoginPassword) { els.adminLoginPassword.value = ''; els.adminLoginPassword.setAttribute('autocomplete', 'new-password'); }
  if (els.adminRememberId) els.adminRememberId.checked = Boolean(state.session.rememberAdminUsername && state.session.rememberedAdminUsername);
  updateViewerLabels();
  renderLauncher();
  navigate('launcher', {}, false);
  if (admin) showToast('관리자 로그아웃 완료', 'success');
}

async function submitSuggestion() {
  const nickname = state.session.userNickname;
  const level = els.suggestionLevel.value.trim();
  const title = els.suggestionTitle.value.trim();
  const content = els.suggestionContent.value.trim();
  if (!nickname) {
    setInlineMessage(els.suggestionFormMessage, '먼저 마크 닉네임을 등록해주세요.', 'error');
    return;
  }
  if (!level || !title || !content) {
    setInlineMessage(els.suggestionFormMessage, '레벨, 요청 제목, 요청 내용을 모두 입력해주세요.', 'error');
    return;
  }
  if (!(await syncLatestSharedData())) {
    setInlineMessage(els.suggestionFormMessage, '공용 데이터 동기화에 실패했습니다. 다시 시도해주세요.', 'error');
    return;
  }
  upsertKnownUser({ nickname, isAdmin: false });
  state.data.suggestions.unshift({ id: uid('sug'), nickname, level, title, content, createdAt: now(), createdByIp: state.session.currentIp });
  logAction(`요청사항 등록: ${title}`, { persist: false });
  await saveData();
  els.suggestionLevel.value = '';
  els.suggestionTitle.value = '';
  els.suggestionContent.value = '';
  setInlineMessage(els.suggestionFormMessage, '요청사항이 저장되었습니다.', 'success');
  showToast('요청사항이 저장되었습니다.', 'success');
}

function runSearch() {
  const query = els.guideSearchInput.value.trim();
  if (!query) {
    setInlineMessage(els.searchMessage, '검색어를 입력해주세요.', 'error');
    return;
  }
  const results = searchPosts(query, els.searchModeSelect.value);
  if (!results.length) {
    setInlineMessage(els.searchMessage, '검색 결과가 없습니다.', 'error');
    return;
  }
  setInlineMessage(els.searchMessage, '');
  els.searchSuggestions.classList.add('hidden');
  navigate('category', { searchResults: results, query });
}

function toggleFavorite() {
  const postId = state.ui.currentPostId;
  if (!postId) return;
  const favorites = getFavoriteIds();
  const next = favorites.includes(postId)
    ? favorites.filter((item) => item !== postId)
    : [...favorites, postId];
  setFavoriteIds(next);
  renderPostView();
}

function exportData() {
  const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `ide-online-guidebook-backup-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showToast('백업 파일을 내보냈습니다.', 'success');
}

function parseJsonInWorker(raw) {
  return new Promise((resolve, reject) => {
    const workerCode = `self.onmessage = (e) => { try { const parsed = JSON.parse(e.data); self.postMessage({ ok: true, parsed }); } catch (error) { self.postMessage({ ok: false }); } };`;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));
    worker.onmessage = (event) => {
      const { ok, parsed } = event.data || {};
      worker.terminate();
      if (ok) resolve(parsed);
      else reject(new Error('invalid'));
    };
    worker.onerror = () => { worker.terminate(); reject(new Error('invalid')); };
    worker.postMessage(raw);
  });
}

async function importData(file) {
  if (!file) return;
  showToast('백업 파일을 불러오는 중입니다...', 'success');
  try {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const raw = await file.text();
    const parsed = await parseJsonInWorker(raw);
    state.data = normalizeLoadedData(parsed);
    await saveData();
    if (isRemoteModeEnabled()) await refreshRemoteSnapshot({ render: false, includePresence: true });
    ensureAdminSessionValid();
    renderAll();
    showToast('백업 데이터를 불러왔습니다.', 'success');
  } catch {
    showToast('백업 파일 형식이 올바르지 않거나 필수 데이터가 누락되었습니다.', 'error');
  } finally {
    if (els.importDataInput) els.importDataInput.value = '';
  }
}

async function resetSeedData() {
  state.data = buildSeedData();
  await saveData();
  if (isRemoteModeEnabled()) await refreshRemoteSnapshot({ render: false, includePresence: true });
  state.ui.editingPostId = null;
  state.ui.editingNoticeId = null;
  state.postDraft = null;
  state.noticeDraft = null;
  state.ui.selectedAdminId = getCurrentAdmin()?.id || null;
  renderAll();
  showToast('샘플 데이터를 초기화했습니다.', 'success');
}

function createPostFromSuggestion(suggestionId) {
  const suggestion = state.data.suggestions.find((item) => item.id === suggestionId);
  if (!suggestion) return;
  state.ui.activeAdminTab = 'posts';
  startNewPost({
    title: suggestion.title,
    summary: `${suggestion.nickname} 님의 요청 기반 초안`,
    blocks: [{ id: uid('block'), type: 'text', text: suggestion.content }],
  });
  renderAdminView({ preserveLayout: false });
  showToast('건의 내용을 게시글 초안으로 가져왔습니다.', 'success');
}

function renderAll() {
  renderLauncher();
  renderGuideHome();
  renderNoticesView();
  renderFavoritesView();
  renderSuggestionsView();
  if (state.ui.currentCategoryId) renderCategoryView();
  if (state.ui.currentPostId) renderPostView();
  if (state.ui.currentNoticeId) renderNoticeDetailView();
  if (getCurrentAdmin()) renderAdminView({ preserveLayout: true });
}

function bindEvents() {
  els.openGuideButton.addEventListener('click', () => {
    if (getCurrentAdmin()) {
      enterGuideHome();
      return;
    }
    if (!state.session.userNickname) {
      openNicknameEntry('guideHome');
      return;
    }
    enterGuideHome();
  });

  els.launcherAdminButton.addEventListener('click', () => {
    if (getCurrentAdmin()) {
      logoutAdmin();
      return;
    }
    navigate('adminLogin');
  });

  els.nicknameEntryForm.addEventListener('submit', (event) => {
    event.preventDefault();
    saveNicknameEntry();
  });
  els.cancelNicknameButton.addEventListener('click', goBack);

  els.globalBackButton.addEventListener('click', goBack);
  els.backButtons.forEach((button) => button.addEventListener('click', goBack));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') goBack();
    if (event.key === 'F12' || (event.ctrlKey && event.shiftKey && ['I','J','C'].includes(event.key.toUpperCase())) || (event.ctrlKey && event.key.toUpperCase() === 'U')) {
      event.preventDefault();
    }
  });
  document.addEventListener('contextmenu', (event) => event.preventDefault());

  els.guideSearchInput.addEventListener('input', () => {
    renderSearchSuggestions();
    if (!els.guideSearchInput.value.trim()) setInlineMessage(els.searchMessage, '');
  });
  els.guideSearchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runSearch();
    }
  });
  els.runSearchButton.addEventListener('click', runSearch);
  els.searchSuggestions.addEventListener('click', (event) => {
    const button = event.target.closest('.suggestion-open-post');
    if (!button) return;
    state.ui.currentPostId = button.dataset.postId;
    renderPostView();
    showView('post');
  });

  els.categoryGrid.addEventListener('click', (event) => {
    const editButton = event.target.closest('.edit-category');
    if (editButton) {
      editCategoryName(editButton.dataset.categoryId);
      return;
    }
    const card = event.target.closest('.open-category-card');
    if (!card) return;
    state.ui.currentCategoryId = card.dataset.categoryId;
    renderCategoryView();
    showView('category');
  });
  els.categoryGrid.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('.open-category-card');
    if (!card) return;
    event.preventDefault();
    state.ui.currentCategoryId = card.dataset.categoryId;
    renderCategoryView();
    showView('category');
  });

  els.categoryPostList.addEventListener('click', (event) => {
    const editButton = event.target.closest('.edit-post-inline');
    if (editButton) {
      const admin = getCurrentAdmin();
      if (!admin) return;
      state.ui.activeAdminTab = 'posts';
      openPostEditor(editButton.dataset.postId);
      renderAdminView();
      showView('admin');
      return;
    }
    const card = event.target.closest('.open-post-card');
    if (!card) return;
    state.ui.currentPostId = card.dataset.postId;
    renderPostView();
    showView('post');
  });
  els.favoritesList.addEventListener('click', (event) => {
    const card = event.target.closest('.open-post-card');
    if (!card) return;
    state.ui.currentPostId = card.dataset.postId;
    renderPostView();
    showView('post');
  });

  [els.noticeList, els.noticePreviewList, els.noticesList].filter(Boolean).forEach((container) => {
    container.addEventListener('click', (event) => {
      const card = event.target.closest('.open-notice-card');
      if (!card) return;
      state.ui.currentNoticeId = card.dataset.noticeId;
      renderNoticeDetailView();
      showView('noticeDetail');
    });
  });

  els.favoritesNavButton.addEventListener('click', () => navigate('favorites'));
  els.guideNoticeNavButton?.addEventListener('click', () => navigate('notices'));
  els.noticePreviewMoreButton?.addEventListener('click', () => navigate('notices'));
  els.suggestionNavButton.addEventListener('click', () => navigate('suggestions'));
  els.changeNicknameButton.addEventListener('click', () => openNicknameEntry(state.ui.currentView || 'guideHome'));
  [els.guideAdminToolsButton, els.categoryAdminToolsButton, els.postAdminToolsButton, els.favoritesAdminToolsButton, els.suggestionsAdminToolsButton].filter(Boolean).forEach((button) => button.addEventListener('click', () => {
    if (getCurrentAdmin()) navigate('admin');
    else navigate('adminLogin');
  }));
  els.categoryHomeButton.addEventListener('click', () => navigate('guideHome'));
  els.categoryNoticeButton?.addEventListener('click', () => navigate('notices'));
  els.categoryFavoritesButton.addEventListener('click', () => navigate('favorites'));
  els.categorySuggestionsButton.addEventListener('click', () => navigate('suggestions'));
  els.categoryNicknameButton.addEventListener('click', () => openNicknameEntry('category'));
  els.changeNicknameFromPostButton.addEventListener('click', () => openNicknameEntry('post'));
  els.favoritesNoticeButton?.addEventListener('click', () => navigate('notices'));
  els.favoritesChangeNicknameButton.addEventListener('click', () => openNicknameEntry('favorites'));
  els.suggestionsNoticeButton?.addEventListener('click', () => navigate('notices'));
  els.suggestionsChangeNicknameButton.addEventListener('click', () => openNicknameEntry('suggestions'));
  [els.guideLogoutButton, els.categoryLogoutButton, els.postLogoutButton, els.favoritesLogoutButton, els.suggestionsLogoutButton].forEach((button) => {
    button.addEventListener('click', logoutAdmin);
  });

  els.toggleFavoriteButton.addEventListener('click', toggleFavorite);
  els.openPostEditButton.addEventListener('click', () => {
    const admin = getCurrentAdmin();
    if (!admin) return;
    state.ui.activeAdminTab = 'posts';
    openPostEditor(state.ui.currentPostId);
    renderAdminView({ preserveLayout: false });
    showView('admin');
  });

  els.suggestionForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitSuggestion();
  });

  els.adminLoginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    loginAdmin();
  });

  els.adminTabs.forEach((tab) => tab.addEventListener('click', async () => {
    state.ui.activeAdminTab = tab.dataset.tab;
    if (isRemoteModeEnabled()) {
      await refreshRemoteSnapshot({ render: false, includePresence: true });
    }
    renderAdminView({ preserveLayout: false });
  }));

  els.adminLogoutButton.addEventListener('click', logoutAdmin);
  els.adminLogoutButtonSide.addEventListener('click', logoutAdmin);
  els.adminSyncNowButton?.addEventListener('click', async () => {
    if (!isRemoteModeEnabled()) {
      showToast('로컬 모드에서는 즉시 동기화가 필요하지 않습니다.', 'success');
      return;
    }
    const ok = await refreshRemoteSnapshot({ render: false, includePresence: true });
    if (!ok) {
      showToast('공용 데이터 동기화에 실패했습니다.', 'error');
      renderAdminOverviewMeta();
      return;
    }
    renderCurrentViewOnly({ preserveAdminLayout: true });
    showToast('최신 공용 데이터를 불러왔습니다.', 'success');
  });
  els.adminHomeButton.addEventListener('click', () => navigate('guideHome'));
  els.adminNoticeButton?.addEventListener('click', () => navigate('notices'));
  els.adminFavoritesButton.addEventListener('click', () => navigate('favorites'));
  els.adminSuggestionsButton.addEventListener('click', () => navigate('suggestions'));
  els.adminNicknameButton.addEventListener('click', () => openNicknameEntry('admin'));
  els.noticesHomeButton?.addEventListener('click', () => navigate('guideHome'));
  els.noticesFavoritesButton?.addEventListener('click', () => navigate('favorites'));
  els.noticesSuggestionsButton?.addEventListener('click', () => navigate('suggestions'));
  els.noticesChangeNicknameButton?.addEventListener('click', () => openNicknameEntry('notices'));
  els.noticesAdminToolsButton?.addEventListener('click', () => { if (getCurrentAdmin()) navigate('admin'); else navigate('adminLogin'); });
  els.noticesLogoutButton?.addEventListener('click', logoutAdmin);
  els.noticeDetailHomeButton?.addEventListener('click', () => navigate('guideHome'));
  els.noticeDetailAdminToolsButton?.addEventListener('click', () => { if (getCurrentAdmin()) navigate('admin'); else navigate('adminLogin'); });
  els.noticeDetailLogoutButton?.addEventListener('click', logoutAdmin);
  els.titleBoldButton?.addEventListener('click', () => applyFormatToTitle('bold'));
  els.titleItalicButton?.addEventListener('click', () => applyFormatToTitle('italic'));
  els.titleUnderlineButton?.addEventListener('click', () => applyFormatToTitle('underline'));
  els.postEditorTitleColor?.addEventListener('input', (event) => applyFormatToTitle('foreColor', event.target.value));
  els.bodyBoldButton?.addEventListener('click', () => applyFormatToBody('bold'));
  els.bodyItalicButton?.addEventListener('click', () => applyFormatToBody('italic'));
  els.bodyUnderlineButton?.addEventListener('click', () => applyFormatToBody('underline'));
  els.postEditorBodyColor?.addEventListener('input', (event) => applyFormatToBody('foreColor', event.target.value));
  els.previewPostButton?.addEventListener('click', renderDraftPreview);
  els.newPostButton.addEventListener('click', () => startNewPost());
  [els.addImageBlockButton, els.addVideoBlockButton].filter(Boolean).forEach((button) => button.addEventListener('mousedown', rememberEditorSelection));
  els.addImageBlockButton.addEventListener('click', () => openInsertPanel('image'));
  els.addVideoBlockButton.addEventListener('click', () => openInsertPanel('video'));
  els.confirmInsertByUrlButton?.addEventListener('click', insertMediaByUrl);
  els.cancelInsertPanelButton?.addEventListener('click', closeInsertPanel);
  els.mediaFileInput?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) { insertMediaFile(file); }
  });
  els.applySelectedMediaWidthButton?.addEventListener('click', applySelectedMediaWidth);
  els.postEditorBody?.addEventListener('keyup', () => { ensureEditorHasEditableBoundaries(); rememberEditorSelection(); });
  els.postEditorBody?.addEventListener('mouseup', () => { ensureEditorHasEditableBoundaries(); rememberEditorSelection(); });
  els.postEditorBody?.addEventListener('focus', () => { ensureEditorHasEditableBoundaries(); rememberEditorSelection(); });
  els.postEditorBody?.addEventListener('input', () => { ensureEditorHasEditableBoundaries(); cleanupEditorBoundarySlots(); rememberEditorSelection(); });
  els.postEditorBody?.addEventListener('click', (event) => {
    ensureEditorHasEditableBoundaries();
    const media = event.target.closest('.editor-media-frame,img,video,.embed-frame-wrap,iframe');
    if (media) {
      const figure = media.classList?.contains('editor-media-frame') ? media : media.closest('.editor-media-frame');
      if (figure && !event.target.closest('.media-resize-handle')) {
        const rect = figure.getBoundingClientRect();
        const offsetY = event.clientY - rect.top;
        if (offsetY < rect.height * 0.22) {
          focusAroundMedia(figure, 'before');
          return;
        }
        if (offsetY > rect.height * 0.78) {
          focusAroundMedia(figure, 'after');
          return;
        }
      }
      selectMediaElement(media);
      return;
    }
    clearSelectedMediaElement();
    rememberEditorSelection();
  });
  els.postEditorBody?.addEventListener('dragstart', (event) => {
    const media = event.target.closest('.editor-media-frame');
    if (!media || event.target.closest('.media-resize-handle')) return;
    draggedMediaElement = media;
    media.classList.add('dragging');
    try { event.dataTransfer?.setData('text/plain', media.dataset.mediaType || 'media'); } catch {}
  });
  els.postEditorBody?.addEventListener('dragend', () => {
    draggedMediaElement?.classList.remove('dragging');
    draggedMediaElement = null;
  });
  els.postEditorBody?.addEventListener('dragover', (event) => {
    event.preventDefault();
  });
  els.postEditorBody?.addEventListener('drop', (event) => {
    event.preventDefault();
    const pointRange = resolveDropRangeFromPoint(event.clientX, event.clientY, draggedMediaElement);
    if (pointRange && els.postEditorBody.contains(pointRange.commonAncestorContainer)) {
      savedEditorRange = pointRange.cloneRange();
    } else {
      rememberEditorSelection();
    }
    const file = event.dataTransfer?.files?.[0];
    if (file) {
      state.ui.mediaInsertType = file.type.startsWith('video/') ? 'video' : 'image';
      if (pointRange) setInsertionMarkerFromRange(pointRange);
      else placeInsertionMarker();
      insertMediaFile(file);
      return;
    }
    if (draggedMediaElement && pointRange) {
      insertExistingMediaAtPoint(draggedMediaElement, pointRange);
      draggedMediaElement.classList.remove('dragging');
      draggedMediaElement = null;
    }
  });
  els.postEditorBody?.addEventListener('paste', (event) => {
    const items = Array.from(event.clipboardData?.items || []);
    const fileItem = items.find((item) => item.kind === 'file' && (item.type.startsWith('image/') || item.type.startsWith('video/')));
    if (!fileItem) return;
    const file = fileItem.getAsFile();
    if (!file) return;
    event.preventDefault();
    state.ui.mediaInsertType = file.type.startsWith('video/') ? 'video' : 'image';
    placeInsertionMarker();
    insertMediaFile(file);
  });

  els.postEditorBody?.addEventListener('keydown', (event) => {
    if (!selectedMediaElement) return;
    const figure = selectedMediaElement.classList?.contains('editor-media-frame') ? selectedMediaElement : selectedMediaElement.closest('.editor-media-frame');
    if (!figure) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      focusAroundMedia(figure, event.shiftKey ? 'before' : 'after');
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      focusAroundMedia(figure, 'after');
      document.execCommand('insertText', false, event.key);
      rememberEditorSelection();
    }
  });
  initMediaResizing();
  els.postEditorForm.addEventListener('submit', (event) => {
    event.preventDefault();
    savePostDraft();
  });
  els.deletePostButton.addEventListener('click', deleteCurrentPost);
  els.cancelPostEditButton.addEventListener('click', () => {
    state.ui.editingPostId = null;
    state.postDraft = null;
    renderPostEditor();
    if (state.remote.pendingSnapshot) applyPendingRemoteSnapshot({ render: true });
  });
  els.adminPostList.addEventListener('click', (event) => {
    const button = event.target.closest('.edit-post');
    if (!button) return;
    openPostEditor(button.dataset.postId);
  });

  els.newNoticeButton.addEventListener('click', startNewNotice);
  els.adminNoticeList.addEventListener('click', (event) => {
    const button = event.target.closest('.edit-notice');
    if (!button) return;
    openNoticeEditor(button.dataset.noticeId);
  });
  els.noticeEditorForm.addEventListener('submit', (event) => {
    event.preventDefault();
    saveNoticeDraft();
  });
  els.deleteNoticeButton.addEventListener('click', deleteCurrentNotice);
  els.cancelNoticeEditButton.addEventListener('click', () => {
    state.ui.editingNoticeId = null;
    state.noticeDraft = null;
    renderNoticeEditor();
    if (state.remote.pendingSnapshot) applyPendingRemoteSnapshot({ render: true });
  });

  els.adminSuggestionList.addEventListener('click', (event) => {
    const button = event.target.closest('.create-post-from-suggestion');
    if (!button) return;
    createPostFromSuggestion(button.dataset.suggestionId);
  });

  els.adminCategoryList?.addEventListener('click', (event) => {
    const editButton = event.target.closest('.edit-category');
    if (editButton) {
      editCategoryName(editButton.dataset.categoryId);
      return;
    }
    const upButton = event.target.closest('.category-move-up');
    if (upButton) {
      moveCategory(upButton.dataset.categoryId, 'up');
      return;
    }
    const downButton = event.target.closest('.category-move-down');
    if (downButton) {
      moveCategory(downButton.dataset.categoryId, 'down');
      return;
    }
    const visibilityButton = event.target.closest('.toggle-category-visibility');
    if (visibilityButton) {
      toggleCategoryVisibility(visibilityButton.dataset.categoryId);
    }
  });
  els.addCategoryButton?.addEventListener('click', addCategory);

  els.adminAccountList.addEventListener('click', (event) => {
    const selectButton = event.target.closest('.select-admin-account');
    const createButton = event.target.closest('.open-create-admin');
    if (createButton) {
      openAdminCreateForm();
      return;
    }
    if (!selectButton) return;
    state.ui.selectedAdminId = selectButton.dataset.adminId;
    renderAdminAccountEditor();
  });
  els.openAdminCreateButton.addEventListener('click', openAdminCreateForm);
  els.cancelAdminCreateButton.addEventListener('click', closeAdminCreateForm);
  els.adminCreateForm.addEventListener('submit', (event) => {
    event.preventDefault();
    createAdminAccount();
  });
  els.adminColorForm.addEventListener('submit', (event) => {
    event.preventDefault();
    saveAdminColor();
  });
  els.adminPasswordForm.addEventListener('submit', (event) => {
    event.preventDefault();
    saveAdminPassword();
  });
  els.deleteAdminButton.addEventListener('click', deleteSelectedAdmin);

  els.exportDataButton.addEventListener('click', exportData);
  els.importDataInput.addEventListener('change', (event) => importData(event.target.files?.[0]));
  els.resetSeedButton.addEventListener('click', resetSeedData);

  els.adminLogList?.addEventListener('click', (event) => {
    const button = event.target.closest('.open-log-detail');
    if (!button) return;
    const item = state.data.logs.find((log) => log.id === button.dataset.logId);
    if (!item) return;
    openDetailModal('작업 로그 상세', `${item.message}\n\n${formatDate(item.createdAt)}`);
  });

  els.detailModalClose?.addEventListener('click', closeDetailModal);
  els.detailModal?.addEventListener('click', (event) => {
    if (event.target === els.detailModal) closeDetailModal();
  });

  document.addEventListener('click', (event) => {
    if (!els.searchSuggestions.contains(event.target) && event.target !== els.guideSearchInput) {
      els.searchSuggestions.classList.add('hidden');
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && els.detailModal && !els.detailModal.classList.contains('hidden')) {
      closeDetailModal();
    }
  });
}

async function init() {
  registerEls();
  state.data = loadData();
  state.session = loadSession();
  state.session.deviceId ||= getOrCreateDeviceId();
  state.session.currentIp = await fetchLocalIp();
  state.theme = loadTheme();
  setupThemeOptions();
  applyTheme(state.theme);
  const remoteReady = await initializeRemoteMode();
  els.launcherVersionText = document.getElementById('launcherVersionText');
  if (els.launcherVersionText) els.launcherVersionText.textContent = `v${APP_VERSION}`;
  if (!remoteReady && state.session.userNickname && !state.session.adminId) upsertKnownUser({ nickname: state.session.userNickname, isAdmin: false });
  if (ensureAdminSessionValid()) {
    updateViewerLabels();
  }
  bindEvents();
  startHeartbeat();
  if (remoteReady) startRemoteSyncLoop();
  window.addEventListener('beforeunload', () => { clearPresenceRecord(); stopRemoteSyncLoop(); });
  renderAll();
  showView('launcher', false);
  if (remoteReady) {
    showToast('공용 다중 사용자 모드가 연결되었습니다.', 'success');
  } else if (isSupabaseConfigured()) {
    showToast('Supabase 연결에 실패해 로컬 모드로 시작했습니다.', 'error');
  }
}

init();

