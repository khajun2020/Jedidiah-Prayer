"use client";

import { useEffect, useMemo, useState } from "react";
import { auth, db } from "@/lib/firebase";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  increment,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
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
  prayedCount: number;
  isAnswered: boolean;
  createdAt?: any;
};

type ViewMode = "all" | "mine" | "byDate";

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

  // 작성 폼
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [content, setContent] = useState("");

  // 목록/댓글
  const [prayers, setPrayers] = useState<Prayer[]>([]);
  const [openCommentsId, setOpenCommentsId] = useState<string | null>(null);

  // 표시 이름 로컬 저장(편의)
  useEffect(() => {
    const saved = localStorage.getItem("jedidiah_display_name");
    if (saved) setDisplayName(saved);
  }, []);

  // Auth 상태 감시
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsLoggedIn(!!u);
      setUserName(u?.displayName || u?.email || "");
      if (!u) setViewMode("all");
    });
    return () => unsub();
  }, []);

  // ===== (정석) viewMode에 따라 Firestore 쿼리를 "따로" 구독 =====
  // - all / byDate: 전체를 createdAt desc로 구독
  // - mine: where(authorUid==uid) + orderBy(createdAt desc) 구독 (복합 인덱스 필요할 수 있음)
  useEffect(() => {
    if (!isLoggedIn) return;

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

  const prayersCountLabel = useMemo(() => `${prayers.length}개`, [prayers.length]);

  // 날짜별 그룹 (byDate에서 사용)
  const groupedByDate = useMemo(() => {
    const map = new Map<string, Prayer[]>();
    for (const p of prayers) {
      const key = p.date || "날짜 없음";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    // "YYYY-MM-DD"이면 문자열 내림차순 정렬로 날짜 내림차순이 잘 동작
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [prayers]);

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
      } else {
        await signInWithEmailAndPassword(auth, e, password);
      }
      setPassword("");
    } catch (err: any) {
      alert(err?.message ?? "로그인/회원가입 중 오류가 발생했습니다.");
    }
  }

  async function handleGoogleLogin() {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (err: any) {
      alert(err?.message ?? "Google 로그인 중 오류가 발생했습니다.");
    }
  }

  async function handleLogout() {
    try {
      await signOut(auth);
      setOpenCommentsId(null);
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

  async function prayPlusOne(prayerId: string) {
    const ref = doc(db, "prayers", prayerId);
    await updateDoc(ref, { prayedCount: increment(1) });
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
  }

  // ===== UI: 로그인 화면 =====
  if (!isLoggedIn) {
    return (
      <div className="min-h-screen flex justify-center px-4">
        <div className="w-full max-w-md py-16">
          <div className="card p-7">
            <h1 className="text-2xl font-semibold tracking-tight">여디디야 기도제목 나눔</h1>
            <p className="text-sm text-neutral-600 mt-2">
              기도제목을 나누고 함께 기도하는 공간입니다.
            </p>

            <div className="mt-6 flex gap-2">
              <button
                className={`btn ${authMode === "signin" ? "btn-primary" : ""}`}
                onClick={() => setAuthMode("signin")}
                type="button"
              >
                로그인
              </button>
              <button
                className={`btn ${authMode === "signup" ? "btn-primary" : ""}`}
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
                  className="w-full input mt-2"
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
                  className="w-full input mt-2"
                  placeholder="example@email.com"
                />
              </div>

              <div>
                <label className="text-sm text-neutral-700">비밀번호</label>
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  className="w-full input mt-2"
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
    <div className="min-h-screen bg-neutral-50">
      {/* 상단 작업표시줄(App Bar) */}
      <div className="fixed top-0 left-0 right-0 z-50 border-b border-neutral-200 bg-white/90 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 py-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="text-lg font-semibold tracking-tight truncate">여디디야 기도제목 나눔</div>
              <div className="text-xs text-neutral-600">
                로그인: <span className="font-medium text-neutral-900">{userName}</span>
              </div>
            </div>

            {/* ✅ 메뉴 탭 + 로그아웃(맨 오른쪽) */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setViewMode("all");
                  setOpenCommentsId(null);
                }}
                className={`btn ${viewMode === "all" ? "btn-primary" : ""}`}
              >
                전체 기도제목
              </button>

              <button
                type="button"
                onClick={() => {
                  setViewMode("mine");
                  setOpenCommentsId(null);
                }}
                className={`btn ${viewMode === "mine" ? "btn-primary" : ""}`}
              >
                나의 기도제목 모아보기
              </button>

              <button
                type="button"
                onClick={() => {
                  setViewMode("byDate");
                  setOpenCommentsId(null);
                }}
                className={`btn ${viewMode === "byDate" ? "btn-primary" : ""}`}
              >
                날짜별 모아보기
              </button>

              <button onClick={handleLogout} className="btn ml-auto">
                로그아웃
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* AppBar 높이만큼 padding-top */}
      <div className="pt-[92px] sm:pt-[68px] flex justify-center px-4">
        <div className="w-full max-w-6xl py-6 text-sm leading-relaxed">
          {/* 2단 레이아웃: flex로 강제 분리 */}
          <div className="flex flex-col lg:flex-row gap-6 items-start">
            {/* 왼쪽: 작성란 */}
            <div className="w-full lg:w-[420px] shrink-0 lg:sticky lg:top-[84px] space-y-4">
              <section className="card p-6">
                <div className="flex flex-col md:flex-row md:items-center gap-3">
                  <div className="flex items-center gap-2">
                    <label className="text-sm text-neutral-700">날짜</label>
                    <input
                      type="date"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                      className="input py-2 px-3"
                    />
                  </div>

                  <label className="inline-flex items-center gap-2 text-sm text-neutral-700 md:ml-auto">
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
                  className="mt-3 w-full input min-h-[140px] resize-none"
                  placeholder="기도제목을 적어 주세요."
                />

                <div className="mt-3 flex justify-end">
                  <button onClick={addPrayer} className="btn btn-primary">
                    기도제목 올리기!
                  </button>
                </div>

                {viewMode === "mine" && (
                  <p className="mt-3 text-xs text-neutral-600">
                    현재 “나의 기도제목 모아보기” 상태입니다. 아래에는 본인 글만 표시됩니다.
                  </p>
                )}

                {viewMode === "byDate" && (
                  <p className="mt-3 text-xs text-neutral-600">
                    현재 “날짜별 모아보기” 상태입니다. 아래에 날짜별로 묶여 표시됩니다.
                  </p>
                )}
              </section>

              <footer className="text-xs text-neutral-600 leading-relaxed">
                * 각자의 기도제목을 편하게 나눠주세요! 기도하겠습니다.
              </footer>
            </div>

            {/* 오른쪽: 목록 */}
            <div className="w-full flex-1 min-w-0 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-neutral-900">
                  {viewMode === "mine"
                    ? "나의 기도제목"
                    : viewMode === "byDate"
                    ? "날짜별 기도제목"
                    : "등록된 기도제목"}
                </h2>
                <span className="text-xs text-neutral-500">{prayersCountLabel}</span>
              </div>

              {viewMode === "mine" && prayers.length === 0 && (
                <div className="card p-6 text-sm text-neutral-700">아직 작성한 기도제목이 없습니다.</div>
              )}

              <section className="space-y-4">
                {/* ✅ byDate일 때: 날짜 헤더로 묶어서 출력 */}
                {viewMode !== "byDate" ? (
                  prayers.map((p) => {
                    const isMine = auth.currentUser?.uid === p.authorUid;

                    return (
                      <div key={p.id} className="card p-6">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm text-neutral-700">
                            작성자:{" "}
                            <span className="font-medium">
                              {p.isAnonymous ? "익명" : p.authorName || "알 수 없음"}
                            </span>
                          </span>
                          <span className="text-xs text-neutral-500">•</span>
                          <span className="text-sm text-neutral-700">날짜: {p.date}</span>
                          {p.isAnswered && <span className="ml-1 badge badge-success">응답됨 🙌</span>}
                        </div>

                        <p className="mt-3 whitespace-pre-wrap leading-relaxed">{p.content}</p>

                        <div className="mt-4 flex flex-wrap gap-2 items-center">
                          <button onClick={() => prayPlusOne(p.id)} className="btn">
                            🙏 기도했어요
                          </button>

                          <span className="text-sm text-neutral-700">
                            기도수: <span className="font-semibold">{p.prayedCount}</span>
                          </span>

                          <button
                            onClick={() => setOpenCommentsId(openCommentsId === p.id ? null : p.id)}
                            className="btn"
                          >
                            💬 댓글
                          </button>

                          <button onClick={() => toggleAnswered(p.id, p.isAnswered)} className="btn">
                            {p.isAnswered ? "응답됨 해제" : "응답됨 표시"}
                          </button>

                          {isMine && (
                            <button onClick={() => deletePrayer(p)} className="btn">
                              🗑️ 삭제
                            </button>
                          )}
                        </div>

                        {openCommentsId === p.id && <Comments prayerId={p.id} />}
                      </div>
                    );
                  })
                ) : groupedByDate.length === 0 ? (
                  <div className="card p-6 text-sm text-neutral-700">표시할 기도제목이 없습니다.</div>
                ) : (
                  groupedByDate.map(([dateKey, list]) => (
                    <div key={dateKey} className="space-y-3">
                      <div className="text-sm font-semibold text-neutral-900">
                        {dateKey} <span className="text-xs text-neutral-500">({list.length}개)</span>
                      </div>

                      {list.map((p) => {
                        const isMine = auth.currentUser?.uid === p.authorUid;

                        return (
                          <div key={p.id} className="card p-6">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm text-neutral-700">
                                작성자:{" "}
                                <span className="font-medium">
                                  {p.isAnonymous ? "익명" : p.authorName || "알 수 없음"}
                                </span>
                              </span>
                              <span className="text-xs text-neutral-500">•</span>
                              <span className="text-sm text-neutral-700">날짜: {p.date}</span>
                              {p.isAnswered && <span className="ml-1 badge badge-success">응답됨 🙌</span>}
                            </div>

                            <p className="mt-3 whitespace-pre-wrap leading-relaxed">{p.content}</p>

                            <div className="mt-4 flex flex-wrap gap-2 items-center">
                              <button onClick={() => prayPlusOne(p.id)} className="btn">
                                🙏 기도했어요
                              </button>

                              <span className="text-sm text-neutral-700">
                                기도수: <span className="font-semibold">{p.prayedCount}</span>
                              </span>

                              <button
                                onClick={() => setOpenCommentsId(openCommentsId === p.id ? null : p.id)}
                                className="btn"
                              >
                                💬 댓글
                              </button>

                              <button onClick={() => toggleAnswered(p.id, p.isAnswered)} className="btn">
                                {p.isAnswered ? "응답됨 해제" : "응답됨 표시"}
                              </button>

                              {isMine && (
                                <button onClick={() => deletePrayer(p)} className="btn">
                                  🗑️ 삭제
                                </button>
                              )}
                            </div>

                            {openCommentsId === p.id && <Comments prayerId={p.id} />}
                          </div>
                        );
                      })}
                    </div>
                  ))
                )}
              </section>

              {/* (선택) 하단 문구를 원하면 여기처럼 return 안 맨 아래에 배치 */}
              <div className="mt-10 border-t border-neutral-200 pt-4 text-center text-xs text-neutral-500 italic">
                “너희도 성령 안에서 하나님의 거하실 처소가 되기 위하여 예수 안에서 함께 지어져 가느니라 [엡 2:22]”
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Comments({ prayerId }: { prayerId: string }) {
  const [items, setItems] = useState<{ id: string; text: string; authorName: string }[]>([]);
  const [text, setText] = useState("");

  useEffect(() => {
    const q = query(collection(db, "prayers", prayerId, "comments"), orderBy("createdAt", "asc"));
    const unsub = onSnapshot(q, (snap) => {
      setItems(
        snap.docs.map((d) => {
          const data = d.data() as any;
          return { id: d.id, text: data.text ?? "", authorName: data.authorName ?? "" };
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
    });

    setText("");
  }

  return (
    <div className="mt-5 card p-4">
      <div className="space-y-3">
        {items.length === 0 ? (
          <div className="text-sm text-neutral-600">아직 댓글이 없습니다.</div>
        ) : (
          items.map((c) => (
            <div key={c.id} className="text-sm">
              <span className="font-medium">{c.authorName}</span>
              <span className="text-neutral-500">: </span>
              <span className="whitespace-pre-wrap">{c.text}</span>
            </div>
          ))
        )}
      </div>

      <div className="mt-4 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="flex-1 input"
          placeholder="댓글을 입력하세요."
        />
        <button onClick={addComment} className="btn btn-primary">
          등록
        </button>
      </div>
    </div>
  );
}
