# 다중 사용자 실운영 전환 가이드

## 이번 패치에서 바뀐 것
- 게시글 / 공지 / 건의 / 로그 저장소를 로컬 localStorage 중심에서 Supabase 공용 상태로 옮길 수 있게 변경
- 관리자 로그인은 로컬 아이디/비밀번호 외에 Supabase Auth 이메일/비밀번호 로그인 지원
- 접속 현황은 guidebook_presence 테이블로 분리
- 이미지/동영상 파일 업로드는 Supabase Storage public bucket 사용
- 여러 클라이언트가 같은 데이터를 보도록 5초 주기 자동 동기화 추가

## 필수 준비물
1. Supabase 프로젝트 1개
2. Project URL
3. Publishable key (또는 구형 anon key)
4. 초기 관리자용 이메일 계정 1개 이상

## 1) 환경변수 파일 생성
프로젝트 루트에 `.env` 파일을 만들고 `.env.example` 값을 채운다.

예시:

```env
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxxxx
VITE_SUPABASE_APP_STATE_ID=main
VITE_SUPABASE_MEDIA_BUCKET=guidebook-media
```

## 2) Supabase SQL 실행
`SUPABASE_SETUP.sql` 전체를 SQL Editor에서 실행한다.

## 3) 첫 관리자 계정 만들기
### 방법 A. Dashboard > Authentication > Users 에서 직접 생성
- 이메일/비밀번호로 첫 관리자 계정 생성
- 생성된 user id(UUID)를 확인

그 다음 SQL Editor에서 아래처럼 profile 행 추가:

```sql
insert into public.guidebook_admin_profiles (
  id,
  email,
  username,
  nickname,
  color,
  is_super_admin,
  disabled
)
values (
  'AUTH_USER_UUID_HERE',
  'admin@example.com',
  'penguin',
  '펭귄',
  '#3a7bff',
  true,
  false
);
```

## 4) 일반 관리자 추가
현재 클라이언트에서 다른 관리자 이메일 계정까지 직접 생성하지는 않는다.
추가 관리자는 아래 순서로 넣는다.
- Authentication > Users 에서 이메일 계정 생성
- `guidebook_admin_profiles` 에 행 추가

예시:

```sql
insert into public.guidebook_admin_profiles (
  id,
  email,
  username,
  nickname,
  color,
  is_super_admin,
  disabled
)
values (
  'SECOND_AUTH_UUID',
  'staff@example.com',
  'staff01',
  '스태프1',
  '#8a63ff',
  false,
  false
);
```

## 5) 기존 로컬 데이터 올리기
- 앱 실행
- 관리자 로그인
- 관리 도구 > 백업 불러오기
- 네가 쓰던 로컬 백업 JSON 선택

그러면 게시글/공지/건의/로그가 공용 DB 상태로 올라간다.

## 6) 실행
```bash
npm install
npm run tauri:dev
```

## 운영 중 알아둘 점
- 관리자 생성/초기 비밀번호 발급: Supabase Dashboard 에서 처리
- 다른 관리자 비밀번호 재설정: Supabase Dashboard 에서 처리
- 본인 비밀번호 변경: 앱에서 가능
- 파일 업로드: 관리자 로그인 상태에서만 가능
- 동기화 주기: 약 5초

## 추천 운영 설정
- Email sign up 을 일반 공개로 두지 말 것
- 첫 관리자/스태프만 대시보드에서 직접 생성할 것
- 배포 전에 `guidebook_app_states` 백업 export 1회 수행할 것
- Storage bucket 은 public read, admin write 구조 유지

## 문제 발생 시 확인 순서
1. `.env` 값 오타 확인
2. SQL 실행 누락 확인
3. `guidebook_admin_profiles` 에 로그인한 auth user id 가 있는지 확인
4. disabled = false 인지 확인
5. Storage bucket 이름이 `.env` 와 SQL 에서 같은지 확인
