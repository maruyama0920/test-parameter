### Cloud Runへデプロイ

```bash
# 方法A: ソースから直接デプロイ（env.yaml使用）
gcloud config set project line-inquiry-473106

gcloud run deploy test-parameter --source .  --region=asia-northeast1  --platform=managed  --allow-unauthenticated --env-vars-file env.yaml
