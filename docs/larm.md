# LARM の接続・予算・session 構成

LARM 接続では毎回接続状態を API で確認し、claim が返した `configuration.fields.baseURL`、`configuration.fields.model`、`credential.token` を使用します。LLM のみなら `providers: ["llm"]`、音声を使う場合は `providers` を省略して Profile 全体を要求します。期限前の renew 後は再claimで token を更新し、終了時に接続を解放します。メインの入力予算は 256072 token、出力上限は 4096 token です。4 セッション構成の目標は、同じ 512K のランタイムを共有するメイン 256K × 1 と補助 64K × 3 です。補助の入力予算は各 59464 token とし、利用側でセッション数と予算を管理します。補助 selector `SAAA-gemma4-26b-64k` は 2026-10-08 時点で catalog が 404 を返すため、コードからも接続を禁止しています。配備後に catalog を確認し、補助の管理処理を実装してから有効化します。

設定は [setup.md](setup.md)(環境変数)と [settings.md](settings.md)(画面)を参照してください。
