# WEB / EXE 배포 가이드

## 1. 웹 배포
1. 프로젝트 루트에 `.env`를 운영용 Supabase 값으로 맞춥니다.
2. 아래 명령으로 웹 빌드를 만듭니다.

```bash
npm.cmd install
npm.cmd run build:web
```

3. `dist` 폴더를 정적 호스팅에 올리면 웹으로 접속할 수 있습니다.
4. 같은 Supabase 프로젝트를 쓰면 EXE와 웹이 같은 데이터를 봅니다.

## 2. EXE 빌드
Windows에서 Tauri 빌드 환경이 준비된 상태에서:

```bash
npm.cmd install
npm.cmd run build:exe
```

빌드가 끝나면 `src-tauri/target/release/bundle` 아래에 설치 파일이 생성됩니다.

## 3. 이번 패치에서 바뀐 운영 동기화
- 5초 자동 동기화: 접속 현황만 갱신
- 전체 데이터 동기화: 관리자 탭 선택 시 / 저장 직후 / 수동 동기화 버튼 클릭 시
- 그래서 개요 탭에서 스크롤이 맨 위로 튀는 현상을 줄였습니다.
