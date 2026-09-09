# StudyVault v26 – Audio Stop Hotfix
- Stoppen der Aufnahme hat höchste Priorität.
- Record-Button nutzt eine defensive Start/Stop-State-Machine.
- SpeechRecognition darf Stop nicht blockieren.
- stopRecording ist idempotent.
- Button bleibt während Recording immer tappbar.
- Visuell klarer Stop-Zustand.
