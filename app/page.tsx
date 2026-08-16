"use client";

import { useEffect, useMemo, useState } from "react";
import { auth, db } from "@/lib/firebase";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  setDoc,
  getDoc,
} from "firebase/firestore";
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  User,
} from "firebase/auth";

type Prayer = {
  id: string;
  date: string;
  content: string;
  isAnonymous: boolean;
  authorUid: string;
  authorName: string;
  prayedCount: number; // DB에는 남겨도 무방(화면에서는 숨김)
  isAnswered: boolean;
  createdAt?: any;
};

type WeeklyPrayer = {
  id: string;
  content: string;
  authorUid: string;
  authorName: string;
  createdAt?: any;
};

type IntercessionItem = {
  id: string; // prayerId를 문서 id로 사용
  prayerId: string;
  prayedAt?: any;
  date?: string;
  content?: string;
  authorName?: string;
  isAnonymous?: boolean;
};

type MemberProfile = {
  uid: string;
  displayName: string;
  email?: string;
  createdAt?: any;
  updatedAt?: any;
};

type ViewMode = "all" | "mine" | "byDate" | "intercession" | "weekly" | "members";

/** (1) 댓글 개수 표시용 훅 */
function useCommentsCount(prayerId: string) {
  const [count, setCount] = useState<number>(0);

  useEffect(() => {
    const q = query(collection(db, "prayers", prayerId, "comments"));
    const unsub = onSnapshot(q, (snap) => setCount(snap.size));
    return () => unsub();
  }, [prayerId]);

  return count;
}

function safeName(u: User | null) {
  return u?.displayName || u?.email || "알 수 없음";
}

async function ensureUserProfile(u: User) {
  // users/{uid} 문서가 없으면 만들고, 있으면 갱신(merge)
  const ref = doc(db, "users", u.uid);
  const snap = await getDoc(ref);
  const displayName = safeName(u);

  if (!snap.exists()) {
    await setDoc(
      ref,
      {
        uid: u.uid,
        displayName,
        email: u.email ?? "",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } else {
    await setDoc(
      ref,
      {
        uid: u.uid,
        displayName,
        email: u.email ?? "",
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  }
}

export default function HomePage() {
  // ===== Auth =====
  const [user, setUser] = useState<User | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [userName, setUserName] = useState("");

  // 로그인 UI
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // 상단 메뉴(보기 모드)
  const [viewMode, setViewMode] = useState<ViewMode>("all");

  // (4) ☰ MENU 드롭다운
  const [menuOpen, setMenuOpen] = useState(false);

  // 작성 폼(일반 기도제목)
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [content, setContent] = useState("");

  // (6) 금주의 기도제목 폼/목록
  const [weeklyMeditation, setWeeklyMeditation] = useState("");
  const [weeklyPersonal, setWeeklyPersonal] = useState("");
  const [weeklyJedidiah, setWeeklyJedidiah] = useState("");
  const [weeklySchool, setWeeklySchool] = useState("");
  const [weeklyPrayers, setWeeklyPrayers] = useState<WeeklyPrayer[]>([]);

  // (5) 중보기도 목록(내가 기도한 목록)
  const [intercessions, setIntercessions] = useState<IntercessionItem[]>([]);

  // 목록/댓글
  const [prayers, setPrayers] = useState<Prayer[]>([]);
  const [openCommentsId, setOpenCommentsId] = useState<string | null>(null);

  // ===== (NEW) 회원별 모아보기 =====
  const [members, setMembers] = useState<MemberProfile[]>([]);
  const [selectedMemberUid, setSelectedMemberUid] = useState<string>(""); // ""이면 아직 선택 안 함
  const [memberPrayers, setMemberPrayers] = useState<Prayer[]>([]);
  const [membersQuery, setMembersQuery] = useState(""); // 이름 검색

  // 표시 이름 로컬 저장(편의)
  useEffect(() => {
    const saved = localStorage.getItem("jedidiah_display_name");
    if (saved) setDisplayName(saved);
  }, []);

  // Auth 상태 감시
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setIsLoggedIn(!!u);
      setUserName(u?.displayName || u?.email || "");
      if (!u) setViewMode("all");

      // 로그인 상태면 users/{uid} 문서 자동 생성/갱신
      if (u) {
        try {
          await ensureUserProfile(u);
        } catch {
          // users 컬렉션 권한이 막혀있으면 여기서 실패할 수 있음 (rules 확인 필요)
        }
      }
    });
    return () => unsub();
  }, []);

  // ===== (정석) viewMode에 따라 Firestore 쿼리를 "따로" 구독 =====
  // - all / byDate: 전체를 createdAt desc로 구독
  // - mine: where(authorUid==uid) + orderBy(createdAt desc) 구독
  // - intercession / weekly / members: 별도 구독
  useEffect(() => {
    if (!isLoggedIn) return;
    if (viewMode === "intercession" || viewMode === "weekly" || viewMode === "members") return;

    const uid = auth.currentUser?.uid;
    if (viewMode === "mine" && !uid) return;

    const base = collection(db, "prayers");
    const q =
      viewMode === "mine"
        ? query(base, where("authorUid", "==", uid), orderBy("createdAt", "desc"))
        : query(base, orderBy("createdAt", "desc")); // all, byDate

    const unsub = onSnapshot(q, (snap) => {
      const items: Prayer[] = snap.docs.map((d) => {
        const data = d.data() as any;
        return {
          id: d.id,
          date: data.date ?? "",
          content: data.content ?? "",
          isAnonymous: !!data.isAnonymous,
          authorUid: data.authorUid ?? "",
          authorName: data.authorName ?? "",
          prayedCount: Number(data.prayedCount ?? 0),
          isAnswered: !!data.isAnswered,
          createdAt: data.createdAt,
        };
      });
      setPrayers(items);
    });

    return () => unsub();
  }, [isLoggedIn, viewMode]);

  // (6) 금주의 기도제목 목록 구독
  useEffect(() => {
    if (!isLoggedIn) return;
    if (viewMode !== "weekly") return;

    const q = query(collection(db, "weekly_prayers"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      const items: WeeklyPrayer[] = snap.docs.map((d) => {
        const data = d.data() as any;
        return {
          id: d.id,
          content: data.content ?? "",
          authorUid: data.authorUid ?? "",
          authorName: data.authorName ?? "",
          createdAt: data.createdAt,
        };
      });
      setWeeklyPrayers(items);
    });

    return () => unsub();
  }, [isLoggedIn, viewMode]);

  // (5) 중보기도 목록 구독
  useEffect(() => {
    if (!isLoggedIn) return;
    if (viewMode !== "intercession") return;

    const uid = auth.currentUser?.uid;
    if (!uid) return;

    const q = query(collection(db, "users", uid, "intercessions"), orderBy("prayedAt", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      const items: IntercessionItem[] = snap.docs.map((d) => {
        const data = d.data() as any;
        return {
          id: d.id,
          prayerId: data.prayerId ?? d.id,
          prayedAt: data.prayedAt,
          date: data.date,
          content: data.content,
          authorName: data.authorName,
          isAnonymous: !!data.isAnonymous,
        };
      });
      setIntercessions(items);
    });

    return () => unsub();
  }, [isLoggedIn, viewMode]);

  // ===== (NEW) members 목록 구독 =====
  useEffect(() => {
    if (!isLoggedIn) return;
    if (viewMode !== "members") return;

    const q = query(collection(db, "users"), orderBy("displayName", "asc"));
    const unsub = onSnapshot(q, (snap) => {
      const items: MemberProfile[] = snap.docs.map((d) => {
        const data = d.data() as any;
        return {
          uid: data.uid ?? d.id,
          displayName: (data.displayName ?? "").toString().trim() || "이름 없음",
          email: (data.email ?? "").toString(),
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
        };
      });

      // 혹시 displayName이 비어있으면 뒤로 보내기
      items.sort((a, b) => {
        const an = (a.displayName || "").trim();
        const bn = (b.displayName || "").trim();
        if (!an) return 1;
        if (!bn) return -1;
        return an.localeCompare(bn, "ko");
      });

      setMembers(items);

      // 최초 진입 시 선택값이 없으면 현재 유저로 자동 선택(원치 않으면 제거 가능)
      if (!selectedMemberUid) {
        setSelectedMemberUid(auth.currentUser?.uid || "anonymous");
      }
    });

    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, viewMode]);

  // ===== (NEW) 선택된 회원의 개인 기도제목(prayers)만 구독 =====
  useEffect(() => {
    if (!isLoggedIn) return;
    if (viewMode !== "members") return;
    if (!selectedMemberUid) return;

    // 익명 분류: isAnonymous==true만 모아서 표시
    if (selectedMemberUid === "anonymous") {
      const q = query(
        collection(db, "prayers"),
        where("isAnonymous", "==", true),
        orderBy("createdAt", "desc")
      );
      const unsub = onSnapshot(q, (snap) => {
        const items: Prayer[] = snap.docs.map((d) => {
          const data = d.data() as any;
          return {
            id: d.id,
            date: data.date ?? "",
            content: data.content ?? "",
            isAnonymous: !!data.isAnonymous,
            authorUid: data.authorUid ?? "",
            authorName: data.authorName ?? "",
            prayedCount: Number(data.prayedCount ?? 0),
            isAnswered: !!data.isAnswered,
            createdAt: data.createdAt,
          };
        });
        setMemberPrayers(items);
      });
      return () => unsub();
    }

    // 회원 선택: 그 사람 글 중에서 "개인 기도제목만" = prayers 컬렉션 + 익명 제외
    const q = query(
      collection(db, "prayers"),
      where("authorUid", "==", selectedMemberUid),
      where("isAnonymous", "==", false),
      orderBy("createdAt", "desc")
    );

    const unsub = onSnapshot(q, (snap) => {
      const items: Prayer[] = snap.docs.map((d) => {
        const data = d.data() as any;
        return {
          id: d.id,
          date: data.date ?? "",
          content: data.content ?? "",
          isAnonymous: !!data.isAnonymous,
          authorUid: data.authorUid ?? "",
          authorName: data.authorName ?? "",
          prayedCount: Number(data.prayedCount ?? 0),
          isAnswered: !!data.isAnswered,
          createdAt: data.createdAt,
        };
      });
      setMemberPrayers(items);
    });

    return () => unsub();
  }, [isLoggedIn, viewMode, selectedMemberUid]);

  const prayersCountLabel = useMemo(() => `${prayers.length}개`, [prayers.length]);

  // 날짜별 그룹 (byDate에서 사용)
  const groupedByDate = useMemo(() => {
    const map = new Map<string, Prayer[]>();
    for (const p of prayers) {
      const key = p.date || "날짜 없음";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [prayers]);

  const filteredMembers = useMemo(() => {
    const q = membersQuery.trim();
    if (!q) return members;
    return members.filter((m) => m.displayName.includes(q) || (m.email || "").includes(q));
  }, [members, membersQuery]);

  const selectedMemberName = useMemo(() => {
    if (selectedMemberUid === "anonymous") return "익명";
    const m = members.find((x) => x.uid === selectedMemberUid);
    return m?.displayName || "회원";
  }, [members, selectedMemberUid]);

  // ===== Auth Actions =====
  async function handleEmailAuth() {
    const e = email.trim();
    if (!e) return alert("이메일을 입력해 주세요.");
    if (!password) return alert("비밀번호를 입력해 주세요.");

    try {
      if (authMode === "signup") {
        const cred = await createUserWithEmailAndPassword(auth, e, password);
        const dn = displayName.trim();
        if (dn) {
          await updateProfile(cred.user, { displayName: dn });
          localStorage.setItem("jedidiah_display_name", dn);
        }
        // users 문서 생성/갱신
        try {
          await ensureUserProfile(cred.user);
        } catch {}
      } else {
        const cred = await signInWithEmailAndPassword(auth, e, password);
        try {
          await ensureUserProfile(cred.user);
        } catch {}
      }
      setPassword("");
    } catch (err: any) {
      alert(err?.message ?? "로그인/회원가입 중 오류가 발생했습니다.");
    }
  }

  async function handleGoogleLogin() {
    try {
      const provider = new GoogleAuthProvider();
      const cred = await signInWithPopup(auth, provider);
      try {
        await ensureUserProfile(cred.user);
      } catch {}
    } catch (err: any) {
      alert(err?.message ?? "Google 로그인 중 오류가 발생했습니다.");
    }
  }

  async function handleLogout() {
    try {
      await signOut(auth);
      setOpenCommentsId(null);
      setMenuOpen(false);
      setSelectedMemberUid("");
      setMembersQuery("");
    } catch (err: any) {
      alert(err?.message ?? "로그아웃 중 오류가 발생했습니다.");
    }
  }

  // ===== Prayer Actions =====
  async function addPrayer() {
    if (!auth.currentUser) return alert("로그인이 필요합니다.");
    const trimmed = content.trim();
    if (!trimmed) return alert("기도제목 내용을 입력해 주세요.");

    await addDoc(collection(db, "prayers"), {
      date,
      content: trimmed,
      isAnonymous,
      authorUid: auth.currentUser.uid,
      authorName: auth.currentUser.displayName ?? auth.currentUser.email ?? "알 수 없음",
      prayedCount: 0,
      isAnswered: false,
      createdAt: serverTimestamp(),
    });

    setContent("");
    setIsAnonymous(false);
  }

  async function toggleAnswered(prayerId: string, current: boolean) {
    const ref = doc(db, "prayers", prayerId);
    await updateDoc(ref, { isAnswered: !current });
  }

  async function deletePrayer(prayer: Prayer) {
    if (!auth.currentUser) return alert("로그인이 필요합니다.");
    if (prayer.authorUid !== auth.currentUser.uid) {
      return alert("본인이 작성한 기도제목만 삭제할 수 있습니다.");
    }

    const ok = confirm("정말 삭제하시겠습니까? (댓글도 함께 삭제됩니다)");
    if (!ok) return;

    // 댓글 subcollection 삭제 시도
    try {
      const commentsQ = query(collection(db, "prayers", prayer.id, "comments"));
      const snap = await getDocs(commentsQ);
      await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
    } catch {}

    await deleteDoc(doc(db, "prayers", prayer.id));
    if (openCommentsId === prayer.id) setOpenCommentsId(null);

    // (5) 내 중보기도 목록에 있으면 같이 제거(선택)
    try {
      const uid = auth.currentUser.uid;
      await deleteDoc(doc(db, "users", uid, "intercessions", prayer.id));
    } catch {}
  }

  // (2) '기도했어요' -> 기도수는 화면에서 삭제 + 자동 댓글 추가
  async function prayAndAutoComment(prayer: Prayer) {
    if (!auth.currentUser) return alert("로그인이 필요합니다.");

    const fixed = "기도합니다. 사랑합니다";

    // 자동 댓글 추가
    await addDoc(collection(db, "prayers", prayer.id, "comments"), {
      text: fixed,
      authorName: auth.currentUser.displayName ?? auth.currentUser.email ?? "알 수 없음",
      authorUid: auth.currentUser.uid,
      createdAt: serverTimestamp(),
      kind: "auto_prayed",
    });

    // 댓글창 자동 오픈
    setOpenCommentsId(prayer.id);

    // (5) 중보기도 목록에 기록(문서 id = prayerId)
    try {
      const uid = auth.currentUser.uid;
      await setDoc(doc(db, "users", uid, "intercessions", prayer.id), {
        prayerId: prayer.id,
        prayedAt: serverTimestamp(),
        date: prayer.date,
        content: prayer.content,
        authorName: prayer.authorName,
        isAnonymous: prayer.isAnonymous,
      });
    } catch {}
  }

  // (6) 금주의 기도제목 추가
  async function addWeeklyPrayer() {
    if (!auth.currentUser) return alert("로그인이 필요합니다.");

    const meditation = weeklyMeditation.trim();
    const personal = weeklyPersonal.trim();
    const jedidiah = weeklyJedidiah.trim();
    const school = weeklySchool.trim();

    if (!meditation && !personal && !jedidiah && !school) {
      return alert("금주의 기도제목 내용을 입력해 주세요.");
    }

    const formatted =
      `<말씀 묵상> ${meditation}\n` +
      `- 개인: ${personal}\n` +
      `- 여디디야: ${jedidiah}\n` +
      `- 학교: ${school}`;

    await addDoc(collection(db, "weekly_prayers"), {
      content: formatted,
      meditation,
      personal,
      jedidiah,
      school,
      authorUid: auth.currentUser.uid,
      authorName: auth.currentUser.displayName ?? auth.currentUser.email ?? "알 수 없음",
      createdAt: serverTimestamp(),
    });

    setWeeklyMeditation("");
    setWeeklyPersonal("");
    setWeeklyJedidiah("");
    setWeeklySchool("");
  }

  async function deleteWeeklyPrayer(item: WeeklyPrayer) {
    if (!auth.currentUser) return alert("로그인이 필요합니다.");
    if (item.authorUid !== auth.currentUser.uid) {
      return alert("본인이 작성한 금주의 기도제목만 삭제할 수 있습니다.");
    }
    const ok = confirm("정말 삭제하시겠습니까?");
    if (!ok) return;

    await deleteDoc(doc(db, "weekly_prayers", item.id));
  }

  function closeMenu() {
    setMenuOpen(false);
  }

  function goto(mode: ViewMode) {
    setViewMode(mode);
    setOpenCommentsId(null);
    setMenuOpen(false);

    if (mode === "members") {
      // 회원별 화면 진입 시 기본 선택(현재 유저 → 없으면 익명)
      setSelectedMemberUid(auth.currentUser?.uid || "anonymous");
    }
  }

  // ===== UI: 로그인 화면 =====
  if (!isLoggedIn) {
    return (
      <div className="login-shell">
        <div className="login-wrap">
          <div className="card login-card">
            <div className="login-brand">
              <div className="brand-mark">
  		<img
    		  src="/jedidiah-logo.png"
    		  alt="여디디야 로고"
    		  className="brand-logo-image"
  		/>
	      </div>
              <div>
                <div className="eyebrow">JEDIDIAH PRAYER</div>
                <h1 className="login-title">여디디야 기도제목 나눔</h1>
              </div>
            </div>
            <p className="login-description">서로의 기도제목을 나누고, 함께 기억하며 기도하는 공간입니다.</p>

            <div className="auth-tabs">
              <button
                className={`auth-tab ${authMode === "signin" ? "is-active" : ""}`}
                onClick={() => setAuthMode("signin")}
                type="button"
              >
                로그인
              </button>
              <button
                className={`auth-tab ${authMode === "signup" ? "is-active" : ""}`}
                onClick={() => setAuthMode("signup")}
                type="button"
              >
                회원가입
              </button>
            </div>

            {authMode === "signup" && (
              <div className="mt-5">
                <label className="text-sm text-neutral-700">표시 이름(선택)</label>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full input mt-2 px-4 py-3"
                  placeholder="예: 하준"
                />
              </div>
            )}

            <div className="mt-5 space-y-3">
              <div>
                <label className="text-sm text-neutral-700">이메일</label>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full input mt-2 px-4 py-3"
                  placeholder="example@email.com"
                />
              </div>

              <div>
                <label className="text-sm text-neutral-700">비밀번호</label>
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  className="w-full input mt-2 px-4 py-3"
                  placeholder="비밀번호"
                />
              </div>

              <button onClick={handleEmailAuth} className="w-full btn btn-primary py-3 font-medium">
                {authMode === "signup" ? "이메일로 회원가입" : "이메일로 로그인"}
              </button>

              <div className="flex items-center gap-3 my-2">
                <div className="h-px flex-1 bg-neutral-200" />
                <span className="text-xs text-neutral-500">또는</span>
                <div className="h-px flex-1 bg-neutral-200" />
              </div>

              <button onClick={handleGoogleLogin} className="w-full btn py-3 font-medium">
                Google로 로그인
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ===== UI: 메인 화면 =====
  return (
    <div className="app-shell">
      {/* 상단 작업표시줄(App Bar) */}
      <header className="app-header">
        <div className="app-header-inner">
          <div className="brand-block">
            <div className="brand-mark">
  		<img
    		  src="/jedidiah-logo.png"
    		  alt="여디디야 로고"
    		  className="brand-logo-image"
  		/>
	    </div>
            <div className="min-w-0">
              <div className="eyebrow">JEDIDIAH PRAYER</div>
              <div className="header-title">여디디야 기도제목 나눔</div>
            </div>
          </div>

          {/* (4) ☰ MENU + 로그아웃 */}
          <div className="header-actions">
            <div className="user-pill" title={userName}>
              <span className="user-dot" aria-hidden="true" />
              <span className="user-name">{userName}</span>
            </div>
              <button
                type="button"
                className="btn menu-trigger"
                onClick={() => setMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                ☰ 메뉴
              </button>

              {menuOpen && (
                <div
                  className="menu-panel"
                  onMouseLeave={() => setMenuOpen(false)}
                >
                  <button
                    className={`w-full text-left btn ${viewMode === "all" ? "btn-primary" : ""}`}
                    onClick={() => goto("all")}
                    type="button"
                  >
                    전체 기도제목
                  </button>
                  <button
                    className={`w-full text-left btn ${viewMode === "mine" ? "btn-primary" : ""}`}
                    onClick={() => goto("mine")}
                    type="button"
                  >
                    나의 기도제목
                  </button>
                  <button
                    className={`w-full text-left btn ${viewMode === "byDate" ? "btn-primary" : ""}`}
                    onClick={() => goto("byDate")}
                    type="button"
                  >
                    날짜별 모아보기
                  </button>

                  {/* (NEW) 회원별 모아보기 */}
                  <button
                    className={`w-full text-left btn ${viewMode === "members" ? "btn-primary" : ""}`}
                    onClick={() => goto("members")}
                    type="button"
                  >
                    회원별 기도제목
                  </button>

                  <div className="my-2 h-px bg-neutral-200" />

                  <button
                    className={`w-full text-left btn ${viewMode === "intercession" ? "btn-primary" : ""}`}
                    onClick={() => goto("intercession")}
                    type="button"
                  >
                    중보기도 목록
                  </button>
                  <button
                    className={`w-full text-left btn ${viewMode === "weekly" ? "btn-primary" : ""}`}
                    onClick={() => goto("weekly")}
                    type="button"
                  >
                    금주의 기도제목
                  </button>

                  <div className="my-2 h-px bg-neutral-200" />

                  <button onClick={() => closeMenu()} className="w-full btn" type="button">
                    닫기
                  </button>
                </div>
              )}

            <button onClick={handleLogout} className="btn logout-button">
              로그아웃
            </button>
          </div>
        </div>
      </header>

      {/* AppBar 높이만큼 padding-top */}
      <main className="app-main">
        <div className="app-container">
          {/* 2단 레이아웃 */}
          <div className="app-layout">
            {/* 왼쪽: 작성란 (viewMode에 따라 다르게) */}
            <aside className="sidebar-column">
              {viewMode === "weekly" ? (
                <section className="card composer-card">
                  <div className="text-base font-semibold text-neutral-900">금주의 기도제목 작성</div>

                  <div className="mt-4 space-y-3">
                    <div>
                      <label className="text-sm text-neutral-700">말씀 묵상</label>
                      <textarea
                        value={weeklyMeditation}
                        onChange={(e) => setWeeklyMeditation(e.target.value)}
                        className="mt-2 w-full input min-h-[90px] resize-none px-4 py-3"
                        placeholder="이번 주 말씀 묵상 내용을 적어 주세요."
                      />
                    </div>

                    <div>
                      <label className="text-sm text-neutral-700">개인</label>
                      <textarea
                        value={weeklyPersonal}
                        onChange={(e) => setWeeklyPersonal(e.target.value)}
                        className="mt-2 w-full input min-h-[70px] resize-none px-4 py-3"
                        placeholder="개인 기도제목"
                      />
                    </div>

                    <div>
                      <label className="text-sm text-neutral-700">여디디야</label>
                      <textarea
                        value={weeklyJedidiah}
                        onChange={(e) => setWeeklyJedidiah(e.target.value)}
                        className="mt-2 w-full input min-h-[70px] resize-none px-4 py-3"
                        placeholder="여디디야 기도제목"
                      />
                    </div>

                    <div>
                      <label className="text-sm text-neutral-700">학교</label>
                      <textarea
                        value={weeklySchool}
                        onChange={(e) => setWeeklySchool(e.target.value)}
                        className="mt-2 w-full input min-h-[70px] resize-none px-4 py-3"
                        placeholder="학교 기도제목"
                      />
                    </div>
                  </div>

                  <div className="mt-3 flex justify-end">
                    <button onClick={addWeeklyPrayer} className="btn btn-primary">
                      금주의 기도제목 올리기!
                    </button>
                  </div>

                  <p className="mt-3 text-xs text-neutral-600">함께 기도해 주세요.</p>
                </section>
              ) : viewMode === "intercession" ? (
                <section className="card composer-card">
                  <div className="text-base font-semibold text-neutral-900">중보기도 목록</div>
                  <p className="mt-3 text-sm text-neutral-700 leading-relaxed">
                    “🙏 기도했어요”를 누른 기도제목이 여기에 기록됩니다. 한 번에 확인할 수 있습니다.
                  </p>
                  <p className="mt-2 text-xs text-neutral-600">
                    (기도 버튼을 누르면 댓글에 “기도합니다. 사랑합니다”가 자동으로 추가됩니다.)
                  </p>
                </section>
              ) : viewMode === "members" ? (
                <section className="card composer-card">
                  <div className="text-base font-semibold text-neutral-900">회원별 기도제목</div>
                  <p className="mt-3 text-sm text-neutral-700 leading-relaxed">
                    아래에서 회원 이름을 선택하면, 해당 회원이 작성한 “개인 기도제목(prayers)”만 모아 볼 수 있습니다.
                    (공동 기도제목인 “금주의 기도제목(weekly_prayers)”은 제외됩니다.)
                  </p>

                  <div className="mt-4">
                    <label className="text-sm text-neutral-700">회원 검색</label>
                    <input
                      value={membersQuery}
                      onChange={(e) => setMembersQuery(e.target.value)}
                      className="w-full input mt-2 px-4 py-3"
                      placeholder="이름 또는 이메일로 검색"
                    />
                  </div>

                  <div className="mt-4 text-xs text-neutral-600">
                    * 익명 글은 “익명”에서 따로 모아 볼 수 있습니다.
                  </div>
                </section>
              ) : (
                <section className="card composer-card">
                  <div className="composer-heading">
                    <div>
                      <div className="eyebrow">SHARE A PRAYER</div>
                      <h2 className="composer-title">기도제목 나누기</h2>
                    </div>
                    <span className="composer-hint">함께 기도할 내용을 적어주세요</span>
                  </div>

                  <div className="composer-options">
                    <div className="flex items-center gap-2">
                      <label className="text-sm text-neutral-700">날짜</label>
                      <input
                        type="date"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                        className="input px-4 py-3"
                      />
                    </div>

                    <label className="anonymous-toggle">
                      <input
                        type="checkbox"
                        checked={isAnonymous}
                        onChange={(e) => setIsAnonymous(e.target.checked)}
                      />
                      익명으로 올리기
                    </label>
                  </div>

                  <textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    className="prayer-textarea input"
                    placeholder="기도제목을 적어 주세요."
                  />

                  <div className="mt-3 flex justify-end">
                    <button onClick={addPrayer} className="btn btn-primary btn-submit">
                      기도제목 올리기
                    </button>
                  </div>

                  {viewMode === "mine" && (
                    <p className="mt-3 text-xs text-neutral-600">
                      현재 “나의 기도제목” 상태입니다. 아래에는 본인 글만 표시됩니다.
                    </p>
                  )}

                  {viewMode === "byDate" && (
                    <p className="mt-3 text-xs text-neutral-600">
                      현재 “날짜별 모아보기” 상태입니다. 아래에 날짜별로 묶여 표시됩니다.
                    </p>
                  )}
                </section>
              )}

              <footer className="sidebar-note">
                <span aria-hidden="true">☀</span>
                각자의 기도제목을 편하게 나눠주세요. 함께 기도하겠습니다.
              </footer>
            </aside>

            {/* 오른쪽: 목록 */}
            <div className="content-column">
              <div className="section-heading-row">
                <div>
                  <div className="eyebrow">PRAYER BOARD</div>
                  <h2 className="section-title">
                  {viewMode === "weekly"
                    ? "금주의 기도제목"
                    : viewMode === "intercession"
                    ? "중보기도 목록"
                    : viewMode === "members"
                    ? `회원별 기도제목 (${selectedMemberName})`
                    : viewMode === "mine"
                    ? "나의 기도제목"
                    : viewMode === "byDate"
                    ? "날짜별 기도제목"
                    : "등록된 기도제목"}
                  </h2>
                </div>

                {viewMode === "weekly" ? (
                  <span className="count-badge">{weeklyPrayers.length}개</span>
                ) : viewMode === "intercession" ? (
                  <span className="count-badge">{intercessions.length}개</span>
                ) : viewMode === "members" ? (
                  <span className="count-badge">{memberPrayers.length}개</span>
                ) : (
                  <span className="count-badge">{prayersCountLabel}</span>
                )}
              </div>

              {/* (NEW) 회원별 기도제목 */}
              {viewMode === "members" && (
                <section className="space-y-4">
                  {/* 상단: 회원 선택 */}
                  <div className="card p-4">
                    <div className="flex flex-wrap gap-2">
                      <button
                        className={`btn ${selectedMemberUid === "anonymous" ? "btn-primary" : ""}`}
                        onClick={() => setSelectedMemberUid("anonymous")}
                        type="button"
                      >
                        익명
                      </button>

                      {filteredMembers.length === 0 ? (
                        <span className="text-sm text-neutral-600">표시할 회원이 없습니다.</span>
                      ) : (
                        filteredMembers.map((m) => (
                          <button
                            key={m.uid}
                            className={`btn ${selectedMemberUid === m.uid ? "btn-primary" : ""}`}
                            onClick={() => setSelectedMemberUid(m.uid)}
                            type="button"
                            title={m.email || ""}
                          >
                            {m.displayName}
                          </button>
                        ))
                      )}
                    </div>
                    <div className="mt-3 text-xs text-neutral-600">
                      * 이름을 누르면 해당 회원의 “개인 기도제목(prayers)”만 표시됩니다.
                    </div>
                  </div>

                  {/* 선택된 회원의 글 목록 */}
                  {memberPrayers.length === 0 ? (
                    <div className="card p-6 text-sm text-neutral-700">
                      {selectedMemberUid === "anonymous"
                        ? "아직 익명 기도제목이 없습니다."
                        : "아직 이 회원이 작성한 개인 기도제목이 없습니다. (익명/공동 글은 제외됩니다)"}
                    </div>
                  ) : (
                    memberPrayers.map((p) => (
                      <PrayerCard
                        key={p.id}
                        p={p}
                        openCommentsId={openCommentsId}
                        setOpenCommentsId={setOpenCommentsId}
                        onPray={prayAndAutoComment}
                        onToggleAnswered={toggleAnswered}
                        onDelete={deletePrayer}
                      />
                    ))
                  )}
                </section>
              )}

              {/* (5) 중보기도 목록 */}
              {viewMode === "intercession" && (
                <section className="space-y-4">
                  {intercessions.length === 0 ? (
                    <div className="card p-6 text-sm text-neutral-700">
                      아직 “🙏 기도했어요”를 누른 기도제목이 없습니다.
                    </div>
                  ) : (
                    intercessions.map((it) => (
                      <div key={it.id} className="card prayer-card">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm text-neutral-700">
                            작성자:{" "}
                            <span className="font-medium">
                              {it.isAnonymous ? "익명" : it.authorName || "알 수 없음"}
                            </span>
                          </span>
                          <span className="text-xs text-neutral-500">•</span>
                          <span className="text-sm text-neutral-700">날짜: {it.date || "-"}</span>
                        </div>
                        <p className="mt-3 whitespace-pre-wrap leading-relaxed">{it.content || ""}</p>

                        <div className="mt-4 flex flex-wrap gap-2 items-center">
                          <button
                            className="btn"
                            onClick={() => {
                              setViewMode("all");
                              setOpenCommentsId(it.prayerId);
                            }}
                          >
                            💬 댓글 보기
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </section>
              )}

              {/* (6) 금주의 기도제목 */}
              {viewMode === "weekly" && (
                <section className="space-y-4">
                  {weeklyPrayers.length === 0 ? (
                    <div className="card p-6 text-sm text-neutral-700">아직 금주의 기도제목이 없습니다.</div>
                  ) : (
                    weeklyPrayers.map((w) => {
                      const isMine = auth.currentUser?.uid === w.authorUid;
                      return (
                        <div key={w.id} className="card prayer-card weekly-card">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm text-neutral-700">
                              작성자: <span className="font-medium">{w.authorName || "알 수 없음"}</span>
                            </span>
                          </div>

                          <p className="mt-3 whitespace-pre-wrap leading-relaxed">{w.content}</p>

                          {isMine && (
                            <div className="mt-4 flex gap-2">
                              <button onClick={() => deleteWeeklyPrayer(w)} className="btn">
                                🗑️ 삭제
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </section>
              )}

              {/* 기존 기도제목(전체/내글/날짜별) */}
              {(viewMode === "all" || viewMode === "mine" || viewMode === "byDate") && (
                <section className="space-y-4">
                  {viewMode === "mine" && prayers.length === 0 && (
                    <div className="card p-6 text-sm text-neutral-700">아직 작성한 기도제목이 없습니다.</div>
                  )}

                  {/* ✅ byDate일 때: 날짜 헤더로 묶어서 출력 */}
                  {viewMode !== "byDate" ? (
                    prayers.map((p) => (
                      <PrayerCard
                        key={p.id}
                        p={p}
                        openCommentsId={openCommentsId}
                        setOpenCommentsId={setOpenCommentsId}
                        onPray={prayAndAutoComment}
                        onToggleAnswered={toggleAnswered}
                        onDelete={deletePrayer}
                      />
                    ))
                  ) : groupedByDate.length === 0 ? (
                    <div className="card p-6 text-sm text-neutral-700">표시할 기도제목이 없습니다.</div>
                  ) : (
                    groupedByDate.map(([dateKey, list]) => (
                      <div key={dateKey} className="space-y-3">
                        <div className="text-sm font-semibold text-neutral-900">
                          {dateKey} <span className="text-xs text-neutral-500">({list.length}개)</span>
                        </div>

                        {list.map((p) => (
                          <PrayerCard
                            key={p.id}
                            p={p}
                            openCommentsId={openCommentsId}
                            setOpenCommentsId={setOpenCommentsId}
                            onPray={prayAndAutoComment}
                            onToggleAnswered={toggleAnswered}
                            onDelete={deletePrayer}
                          />
                        ))}
                      </div>
                    ))
                  )}
                </section>
              )}

              <div className="verse-footer">
                <span className="verse-mark" aria-hidden="true">“</span>
                <span>너희도 성령 안에서 하나님이 거하실 처소가 되기 위하여 그리스도 예수 안에서 함께 지어져 가느니라</span>
                <strong>엡 2:22</strong>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function PrayerCard({
  p,
  openCommentsId,
  setOpenCommentsId,
  onPray,
  onToggleAnswered,
  onDelete,
}: {
  p: Prayer;
  openCommentsId: string | null;
  setOpenCommentsId: (v: string | null) => void;
  onPray: (prayer: Prayer) => Promise<void>;
  onToggleAnswered: (prayerId: string, current: boolean) => Promise<void>;
  onDelete: (prayer: Prayer) => Promise<void>;
}) {
  const isMine = auth.currentUser?.uid === p.authorUid;

  // (1) 댓글 개수
  const commentsCount = useCommentsCount(p.id);

  return (
    <article className={`card prayer-card ${p.isAnswered ? "is-answered" : ""}`}>
      <div className="prayer-card-head">
        <div className="author-block">
          <div className="author-avatar" aria-hidden="true">
            {p.isAnonymous ? "익" : (p.authorName || "?").trim().slice(0, 1)}
          </div>
          <div className="min-w-0">
            <div className="author-name">{p.isAnonymous ? "익명" : p.authorName || "알 수 없음"}</div>
            <div className="prayer-date">{p.date || "날짜 없음"}</div>
          </div>
        </div>

        {p.isAnswered && <span className="badge badge-success">응답됨 🙌</span>}
      </div>

      <p className="prayer-content">{p.content}</p>

      <div className="prayer-actions">
        {/* (2) 기도수 UI 삭제 + 자동 댓글 */}
        <button onClick={() => onPray(p)} className="btn btn-pray">
          <span aria-hidden="true">🙏</span>
          기도했어요
        </button>

        {/* (1) 댓글 옆 댓글 개수 */}
        <button
          onClick={() => setOpenCommentsId(openCommentsId === p.id ? null : p.id)}
          className={`btn btn-quiet ${openCommentsId === p.id ? "is-active" : ""}`}
        >
          <span aria-hidden="true">💬</span>
          댓글 <span className="action-count">{commentsCount}</span>
        </button>

        {isMine && (
          <div className="owner-actions">
            <button onClick={() => onToggleAnswered(p.id, p.isAnswered)} className="btn btn-owner">
              {p.isAnswered ? "응답됨 해제" : "응답됨 표시"}
            </button>

            <button onClick={() => onDelete(p)} className="btn btn-danger">
              삭제
            </button>
          </div>
        )}
      </div>

      {openCommentsId === p.id && <Comments prayerId={p.id} />}
    </article>
  );
}

function Comments({ prayerId }: { prayerId: string }) {
  const [items, setItems] = useState<{ id: string; text: string; authorName: string; authorUid?: string }[]>([]);
  const [text, setText] = useState("");

  useEffect(() => {
    const q = query(collection(db, "prayers", prayerId, "comments"), orderBy("createdAt", "asc"));
    const unsub = onSnapshot(q, (snap) => {
      setItems(
        snap.docs.map((d) => {
          const data = d.data() as any;
          return {
            id: d.id,
            text: data.text ?? "",
            authorName: data.authorName ?? "",
            authorUid: data.authorUid ?? "",
          };
        })
      );
    });
    return () => unsub();
  }, [prayerId]);

  async function addComment() {
    if (!auth.currentUser) return;
    if (!text.trim()) return;

    await addDoc(collection(db, "prayers", prayerId, "comments"), {
      text: text.trim(),
      authorName: auth.currentUser.displayName ?? auth.currentUser.email ?? "알 수 없음",
      authorUid: auth.currentUser.uid,
      createdAt: serverTimestamp(),
      kind: "user",
    });

    setText("");
  }

  async function deleteComment(commentId: string) {
    if (!auth.currentUser) return alert("로그인이 필요합니다.");

    const ok = confirm("이 댓글을 삭제하시겠습니까?");
    if (!ok) return;

    await deleteDoc(doc(db, "prayers", prayerId, "comments", commentId));
  }

  return (
    <div className="comments-panel">
      <div className="comments-title">
        <span>댓글</span>
        <span className="comments-count">{items.length}</span>
      </div>

      <div className="comments-list">
        {items.length === 0 ? (
          <div className="empty-comments">아직 댓글이 없습니다.</div>
        ) : (
          items.map((c) => {
            const isMine = auth.currentUser?.uid && c.authorUid === auth.currentUser.uid;

            return (
              <div key={c.id} className="comment-item">
                <div className="comment-avatar" aria-hidden="true">
                  {(c.authorName || "?").trim().slice(0, 1)}
                </div>

                <div className="comment-body">
                  <div className="comment-author">{c.authorName || "알 수 없음"}</div>
                  <div className="comment-text whitespace-pre-wrap">{c.text}</div>
                </div>

                {isMine && (
                  <button className="comment-delete" onClick={() => deleteComment(c.id)} type="button">
                    삭제
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="comment-compose">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="flex-1 input"
          placeholder="댓글을 입력하세요."
        />
        <button onClick={addComment} className="btn btn-primary comment-submit">
          등록
        </button>
      </div>
    </div>
  );
}
