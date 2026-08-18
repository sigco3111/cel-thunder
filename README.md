# 셀 썬더 (Cel Thunder)

> **한국어 패치된 포크** — 원본: [PauliusOS/cel-thunder](https://github.com/PauliusOS/cel-thunder) · **라이브 플레이**: [https://sigco3111.github.io/cel-thunder/](https://sigco3111.github.io/cel-thunder/)

브라우저에서 즐기는 셀셰이딩 WWII 항공전 게임. 클라이언트는 Three.js, 서버는 권위 있는 Node 시뮬레이션, 실시간 멀티플레이어, 그리고 모든 자산 — 메시, 텍스처, 사운드 — 이 로드 시점에 절차적으로 생성됩니다. 이 저장소에는 바이너리 아트 자산이 **단 하나도** 들어있지 않습니다.

전체 코드는 단 한 번의 프롬프트로 만들어졌다는 점이 흥미로운데, 자세한 과정은 [ORIGIN.md](ORIGIN.md)에 정리되어 있습니다.

---

## 🎮 시작하기

### 1. 설치 & 실행

```bash
npm install
npm run dev      # vite (포트 5233) + 게임 서버 (포트 8791)
```

브라우저에서 <http://localhost:5233> 을 여세요. 게임 서버가 실행 중이지 않더라도 클라이언트가 자동으로 **오프라인 샌드박스** 모드(AI 대전)로 진입하므로, 항상 플레이가 가능합니다.

| 스크립트 | 설명 |
|---|---|
| `npm run dev` | 클라이언트 + 서버 동시 실행 (개발용) |
| `npm run web` | 클라이언트만 실행 (오프라인 샌드박스) |
| `npm run server` | 권위 서버만 실행 (멀티플레이어) |
| `npm run check` | `tsc --noEmit` — 타입 검사 |
| `npm run build` | 타입 검사 + 프로덕션 번들 |
| `npm run selftest` | 비행 모델과 탄도학 헤드리스 단위 테스트 |
| `npm run shoot` | 시각 평가용 스크린샷 캡처 (shots/ 폴더) |

### 2. 라이브 데모

GitHub Pages에 정적 빌드가 배포되어 있습니다:

- 🇰🇷 **한글판**: <https://sigco3111.github.io/cel-thunder/>
- 🌐 **원본 (영문)**: <https://cel-thunder.vercel.app>

> ⚠️ 정적 호스팅(Web/GitHub Pages)은 WebSocket 서버를 운영할 수 없으므로 **오프라인 샌드박스(AI 대전)** 모드로 동작합니다. 실시간 멀티플레이어를 플레이하려면 `npm run dev`로 로컬에서 권위 서버까지 함께 띄워야 합니다.

---

## ✈️ 핵심 기능

- 🎨 **셀셰이딩 비주얼** — 카툰 스타일의 양키 윤곽선, 양자화된 라이팅, 깊이+법선 엣지 디텍트 + 히어로 오브젝트 인버티드 헐
- 🌥️ **볼류메트릭 클라우드** — 레이 마칭으로 구현된 3차원 구름 레이어
- 🎵 **절차적 사운드** — 모든 음향 효과가 Web Audio API로 실시간 합성 (오디오 파일 없음)
- 🛩️ **코어 옵션** — 5개 기체 (스핏파이어 Mk IX, P-51D 무스탱, La-5FN 등) — 영국/미국/소련/독일/일본
- 🕹️ **다중 조작 방식** — 마우스 에임, 어시스트, 리얼리스틱, 시뮬레이터 4단계
- 🌐 **권위 있는 넷코드** — 60 Hz 서버 틱, 20 Hz 스냅샷, 클라이언트 예측, 리콘실리에이션, 엔티티 보간, 랙 보상
- 🤖 **오프라인 샌드박스** — 서버 없이도 AI와 대전 가능

---

## 🏗️ 아키텍처

전체 코드는 **Subsystem** (서브시스템) 패턴으로 구성되어 있습니다. 각각은 `init` / `update` / `lateUpdate` / `resize` / `dispose` 라이프사이클을 가지며, `src/main.ts`에서 의존성 순서대로 등록됩니다. 서브시스템 간 통신은 `GameContext`와 이벤트 버스를 통해서만 이루어져 — 내부 상태를 직접 만지지 않는 규약 덕분에 병렬 개발이 가능했습니다.

### 디렉토리 구조

```
src/
├─ shared/        순수 TypeScript, three.js 미사용 — 클라이언트/서버 모두 import
│  ├─ math.ts       벡터, 쿼터니언, 결정론적 RNG
│  ├─ protocol.ts   바이너리 와이어 포맷, 엔티티/인풋 패킹, 메시지 ID
│  ├─ aircraft.ts   5개 기체: 공기역학, 엔진, 기관포, 지오메트리, 도장
│  ├─ flight/       표면별 공기역학, 엔진, 지상 핸들링
│  └─ combat/       탄도학, 관통, 모듈러 데미지
├─ engine/        게임 루프, GameContext, 서브시스템 레지스트리, 인풋, 카메라
├─ render/        셀 머티리얼, 컴포저 패스, 하늘 + 볼류메트릭 클라우드
├─ world/         스트리밍 지형, 물, 비행장, 구조물
├─ assets/        절차적 항공기 메시와 도장 텍스처
├─ game/          엔티티 표현, 클라이언트 예측 + 리콘실리에이션
├─ net/           스냅샷 클라이언트, 보간, 리콘실리에이션
├─ vfx/  ui/  audio/
server/
├─ index.ts       WebSocket 호스트, 룸, 헬스체크 엔드포인트
├─ Room.ts        60 Hz 고정 권위 시뮬레이션, 20 Hz 스냅샷
tools/
├─ shoot.mjs      Playwright 스크린샷 하네스 (비평 루프)
```

### 왜 `shared/` 가 three.js 를 import 하지 않는가?

서버는 Node 위에서 동작하므로 three.js 의존성이 들어오면 런타임에 즉시 깨집니다(`THREE.*` 타입만 참조해도 컴파일은 통과합니다). 그래서 `src/shared/`는 클라이언트와 서버 양쪽에서 안전하게 import할 수 있도록 설계 경계를 강제하고 있습니다. `npx tsc --noEmit` 으로는 잡히지 않는 런타임 버그를 만들지 않기 위한 규칙입니다.

---

## 🌐 넷코드 (Netcode)

권위 서버(Authoritative Server) 기반의 표준 웹 게임 넷코드를 구현했습니다.

| 항목 | 설명 |
|---|---|
| **서버 틱** | 고정 60 Hz — 권위 시뮬레이션 |
| **스냅샷 주기** | 20 Hz — 바이너리 압축 |
| **클라이언트 예측** | 로컬 입력을 즉시 동일한 결정론적 비행 모델로 시뮬레이션 |
| **리콘실리에이션** | 스냅샷마다 마지막 사용 인풋 시퀀스 ACK. 작은 차이는 ~150 ms 동안 부드럽게 블렌드, 큰 차이는 즉시 보정 + 펜딩 인풋 버퍼 재실행 |
| **엔티티 보간** | 원격 항공기는 두 스냅샷 사이 ~100 ms 과거 시점 렌더링, 스냅샷 분실 시 캡된 보외법 |
| **랙 보상** | 서버는 엔티티별 1초치 변환 이력을 보관, 히트 판정 시 리와인드 |
| **인풋 패킷** | 최신 프레임 + 직전 3개 프레임을 함께 전송 — 패킷 손실 시 재전송 불필요 |
| **압축** | 오리엔테이션은 4바이트 smallest-three 쿼터니언, 풀 엔티티 44바이트 |

---

## 🎨 아트 디렉션

전체 사양은 `docs/AGENT_BRIEF.md`, 그리고 매 프레임이 받아야 할 기준은 `docs/VISUAL_RUBRIC.md`에 정리되어 있습니다.

짧게 요약하면:

- **라이팅은 양자화, 디테일은 아님** — 라이팅은 단계를 쪼개고, 디테일은 끝까지 갈 것
- **그림자는 색을 가진다** — 회색 그림자는 금지
- **잉크 아웃라인** — 깊이+법선 엣지 디텍트 + 히어로 오브젝트 인버티드 헐
- **패널 라인, 리벳, 웨더링** — 깨끗한 무텍스처 표면은 버그
- **셀셀러 룩** — 만화책 / 그래픽 노블 스타일의 군사 HUD

---

## 🛠️ 기술 스택

- **TypeScript 7** — 전체 코드베이스 pure TS
- **Three.js** — WebGL2 렌더링 엔진
- **Vite 8** — 빌드 도구 및 dev 서버
- **ws** — Node.js WebSocket 서버
- **tsx** — TypeScript 직접 실행

---

## 🤝 기여하기

기여를 환영합니다! PR이 통과해야 할 검사와 아키텍처 규칙은 [CONTRIBUTING.md](CONTRIBUTING.md) 에 정리되어 있습니다.

**핵심 규칙 3가지:**

1. **`src/shared/` 는 three.js를 import 하지 않는다** — 서버 런타임 보호
2. **서브시스템은 이벤트 버스와 `GameContext`로만 통신한다** — 직접 참조 금지
3. **비행 모델은 결정론적이어야 한다** — `Math.random()` 금지, 시드된 RNG 사용

PR 전에 다음 검증을 통과해야 합니다:

```bash
npm run check      # tsc --noEmit
npm run selftest   # 비행 모델/탄도학 헤드리스 테스트
npm run build      # 타입 검사 + 프로덕션 번들
```

---

## 🌏 한글화 (이 포크)

이 포크는 셀 썬더의 **한국어 인터페이스**를 제공합니다. ⚠️ 단, 게임 자체는 영문 빌드 위에 i18n 인프라를 입혀서 한국어 UI를 입히는 구조입니다. 영문 원본과 100% 동일한 게임플레이를 한국어 메뉴/명령어/지시문으로 즐길 수 있습니다.

### 변경 사항

- `src/i18n.ts` — 327개 한국어 키 (KO ↔ EN 1:1 매칭)
- 18개 UI 파일 — `setText(el, '영문')` → `setText(el, t('KO_key'))` 패턴 일괄 치환
- `index.html` — `<html lang="ko">`, `<title>셀 썬더</title>`
- `vite.config.ts` — `base: '/cel-thunder/'` (GitHub Pages 호환)
- `src/ui/theme.ts` — NATION_LABEL(영국/미국/소련/독일/일본), ROLE_LABEL(전투기/요격기/공격기 등) 한국어
- `src/engine/input/bindings.ts` — 키 바인딩 그룹 제목 (비행/엔진/무장/기체/시점/트림/인터페이스) 한국어

### 디자인 노트

- **esbuild inline-injection 회피**: `t()` 호출 시 `globalThis.__tResolver` 패턴 사용 — i18n.ts가 자기 자신을 import 시점에 설치
- **유물명/식별자 보존**: 기체명 (Spitfire Mk IX, P-51D Mustang), 지명 (Normandy Coast), 키보드 코드 (KeyW, ArrowUp)는 원문 유지
- **단위/약어 보존**: GEAR / FLAPS / WEP / km/h / m/s 같은 항공/기술 약어는 변경하지 않음
- **4가지 검증 모두 통과**: Pages API status `built`, bundle HTTP 200, `lang="ko"` 메타, KO 다중어절 grep 매칭

### 새 번역 기여

한국어 번역에 오타/어색한 표현이 있다면 PR 환영합니다. 절차는 일반 기여 가이드와 동일합니다.

---

## 📜 라이선스

**MIT** — 자세한 내용: [LICENSE](LICENSE)

원본 저장소: [PauliusOS/cel-thunder](https://github.com/PauliusOS/cel-thunder)
이 포크: [sigco3111/cel-thunder](https://github.com/sigco3111/cel-thunder)

원본 개발자에게 깊은 감사를 표합니다. 단일 프롬프트에서 WW II 항공전 게임을 구현해낸 작업은 정말 인상적입니다.
