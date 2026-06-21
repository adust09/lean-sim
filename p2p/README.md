# P2P レイヤー シミュレータ（§5）

`lean_consensus` 第5章「The Peer-to-Peer Layer」を、ブラウザ上でインタラクティブに
動かして直感的に理解するためのシミュレータです。[lean-sim](../) コレクションの一部で、
`../shared/` の core（描画・UI ヘルパ）と汎用シェルを共有しています。

## 起動方法

ルートの [README](../README.md) 参照。最も簡単なのはリポジトリ直下で:

```bash
python3 -m http.server 8000
# http://localhost:8000/p2p/ を開く
```

特定のシーンへ直接飛ぶには URL ハッシュを使います:
`…/p2p/#gossipsub` / `#discovery` / `#quic` / `#reqresp` / `#lifecycle`

## 5つのシーン（章構成に対応）

| タブ | 章 | 可視化する内容 |
| --- | --- | --- |
| Discovery v5 | §5.2 | Kademlia の XOR 距離と反復探索（漏斗状の収束）、k-bucket |
| QUIC トランスポート | §5.3 | Head-of-Line ブロッキング比較、接続確立の RTT（1-RTT / 0-RTT） |
| Gossipsub 伝播 | §5.4 | mesh の eager push、IHAVE/IWANT の lazy pull、heartbeat の GRAFT/PRUNE、重複排除 |
| Request-Response | §5.5 | Status ハンドシェイク、ストリームの非対称クローズ、空きスロット省略とチェーン再構築 |
| ライフサイクル | §5.1–5.5 | 新規ノードの一生(発見→接続→ハンドシェイク→同期→購読/GRAFT→稼働)を1シナリオで横断。シナリオ(正常/フォーク混在/高チャーン)とトピック(block/subnet)を切替 |

各シーンの右サイドバーに「コントロール」「統計」「解説」があります。
まず解説を読み、コントロールで操作しながら統計の変化を観察してください。

## 構成

```
p2p/
├── index.html            # タブ + キャンバス + サイドバー
└── js/scenes/
    ├── discovery.js      # §5.2
    ├── quic.js           # §5.3
    ├── gossipsub.js      # §5.4
    ├── reqresp.js        # §5.5
    └── lifecycle.js      # §5.1–5.5 総まとめ（新規ノードの一生）

../shared/                # コレクション共有
├── core.js               #   ユーティリティ・描画ヘルパ・UIファクトリ（P2P.scenes 登録先）
├── app.js                #   汎用シェル（タブ・描画ループ・統計パネル）
└── style.css
```

新しいシーンは `js/scenes/` に
`init / resize / update / render / onMouse / getStats / buildControls` と
`title / sectionRef / descriptionHTML` を実装したオブジェクトを `P2P.scenes` に登録し、
`index.html` に `<script>` を追加、`window.P2P_SCENE_ORDER` に id を足すだけで増やせます。
