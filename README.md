# lean-sim

[Lean Consensus](https://github.com/leanEthereum/leanSpec) の各章で説明される仕組みを、
ブラウザ上で動かして直感的に理解するための**インタラクティブ・シミュレータ集**です。
ビルド不要・依存ライブラリなしのバニラ JavaScript + HTML Canvas で実装されています。

## 起動方法

### 方法 A: ファイルを直接開く

ルートの `index.html`（トピック一覧）をブラウザで開きます。
ES モジュールではなくクラシックスクリプトで読み込むため `file://` でそのまま動きます。

```bash
xdg-open index.html        # Linux
```

### 方法 B: ローカルサーバ経由（推奨）

```bash
python3 -m http.server 8000
# ブラウザで http://localhost:8000 を開く
```

## 収録シミュレータ

| トピック | 章 | 状態 | 内容 |
| --- | --- | --- | --- |
| [P2P レイヤー](p2p/) | §5 | ✅ 利用可能 | Discovery v5 / QUIC / Gossipsub / Request-Response / 参加〜稼働ライフサイクル |
| [SSZ エンコーディング](ssz/) | §2 | ✅ 利用可能 | オフセット直列化 / Merkleization / generalized index 証明 |
| [時間モデル](time/) | §3 | ✅ 利用可能 | スロットと4インターバル / リアルタイムのスロットクロック / タイミングゲーム |
| [状態遷移関数](state/) | §4 | ✅ 利用可能 | 4 フェーズの遷移パイプライン / 状態・ブロックの解剖図 |
| [コンセンサス](consensus/) | §6 | ✅ 利用可能 | source–target–head / フォーク選択 / attestation 集約と set-cover |
| [統括 (全章)](protocol/) | §2–6 | ✅ 利用可能 | 全章を1本のスロット・ハートビートで統合した「生きたチェーン」 |

## 構成

```
lean-sim/
├── index.html          # ランディング（トピック一覧）
├── shared/             # 全シミュレータで共有
│   ├── core.js         #   ユーティリティ・描画ヘルパ・UIファクトリ
│   ├── app.js          #   汎用シェル（タブ・描画ループ・統計パネル）
│   └── style.css
├── p2p/                # §5 P2P シミュレータ
│   ├── index.html
│   ├── README.md
│   └── js/scenes/      #   discovery / quic / gossipsub / reqresp / lifecycle
└── (将来) ssz/  time/  state/  consensus/ ...
```

## 新しいトピックの追加方法

1. `shared/core.js` の `P2P.scenes` に、
   `init / resize / update / render / onMouse / getStats / buildControls` と
   `title / sectionRef / descriptionHTML` を実装したシーンオブジェクトを登録する
   シーンファイルを `<topic>/js/scenes/` に作る。
2. `<topic>/index.html` で `../shared/style.css`・`../shared/core.js`・各シーン・
   `../shared/app.js` を読み込み、`window.P2P_SCENE_ORDER = [...]` で表示順を宣言。
3. ルート `index.html` のトピック一覧にカードを追加。

共有シェルはページ側の `P2P_SCENE_ORDER` を読むので、各トピックは独立して増やせます。
