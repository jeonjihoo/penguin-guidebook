# 이번 수정 내용

## 코드 수정
- localStorage / import 데이터 로딩 시 스키마 정규화 추가
- 잘못된 백업 파일 로딩 시 앱이 깨질 가능성 완화
- 관리자 화면에 운영 모드 / 기본 계정 경고 표시 추가
- 관리자 로그인 시 기본 비밀번호 유지 경고 추가
- '접속 중' 표현을 '최근 기록'으로 수정

## 설정 수정
- tauri.conf.json 버전 2.0.0으로 정렬
- package-lock.json 내부 레지스트리 주소를 npmjs 공용 주소로 수정
- .npmrc 추가(registry=https://registry.npmjs.org/)
- README / 운영 문서 갱신

## 새 문서
- OPERATIONS_CHECKLIST.md
- REAL_OPERATION_REQUIREMENTS.md
- OPS_PATCH_NOTES.md

- 관리자 계정 탭에 비밀번호 변경 기능 추가 (본인 변경 / 슈퍼관리자 재설정)
