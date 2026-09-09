# StudyVault v25 – Safari Live Transcription

Audio workflow:
1. MediaRecorder keeps the real audio recording.
2. On Safari/iOS, webkitSpeechRecognition runs in parallel in German.
3. Recognized final/interim speech is collected live.
4. When the user taps Weiter, the on-device/browser transcript is used immediately when enough text exists.
5. Only if live recognition yielded no usable text does StudyVault fall back to /api/transcribe.

Benefits:
- avoids Netlify AI Gateway for normal iPhone/iPad audio reports
- faster
- no AI credits for successful browser transcription
- still keeps the actual audio recording workflow
