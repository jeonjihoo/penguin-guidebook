# IDE-ONLINE EASY GUIDE BOOK v2.0.0

이 버전은 **로컬 파일럿 운영판**입니다.

## 지금 가능한 운영 범위
- 한 PC / 한 Tauri 앱 기준 공략집 열람/편집
- 로컬 저장(localStorage) 기반 데이터 유지
- 관리자 로그인, 게시글/공지/건의 관리
- 백업 JSON 내보내기 / 가져오기

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

> 운영에 들어가기 전 반드시 비밀번호를 변경하세요.

## 추가 문서
- `OPERATIONS_CHECKLIST.md`
- `REAL_OPERATION_REQUIREMENTS.md`
