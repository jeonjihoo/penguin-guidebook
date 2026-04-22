# IDE-ONLINE EASY GUIDE BOOK v2.0.0

이 버전은 **로컬 파일럿 운영판**입니다.

## 지금 가능한 운영 범위
- 한 PC / 한 Tauri 앱 기준 공략집 열람/편집
- 로컬 저장(localStorage) 기반 데이터 유지
- 관리자 로그인, 게시글/공지/건의 관리
- 백업 JSON 내보내기 / 가져오기

## 아직 안 되는 것
- 여러 유저가 동시에 같은 데이터를 보는 실시간 운영
- 공용 DB 기반 동기화
- 서버형 관리자 권한/비밀번호 해시 저장
- 중앙 로그/모니터링

## 운영 전 필수
1. 기본 관리자 계정 비밀번호를 바로 변경
2. 백업 파일 주기적으로 내보내기
3. 파일럿 운영인지, 실제 다중 사용자 운영인지 먼저 결정

## 실행
```powershell
npm.cmd install
npm.cmd run tauri:dev
```

## 빌드
```powershell
npm.cmd run tauri:build
```

## 기본 관리자 계정
- 아이디: `jeonjihoo`
- 비밀번호: `caption1216!`
- 표시 닉네임: `펭귄(관리자)`

> 운영에 들어가기 전 반드시 비밀번호를 변경하세요.

## 추가 문서
- `OPERATIONS_CHECKLIST.md`
- `REAL_OPERATION_REQUIREMENTS.md`
