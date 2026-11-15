"""Offline CPU dictation. Audio and transcripts are never logged."""
import argparse
import json
import sys
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

parser = argparse.ArgumentParser()
parser.add_argument('--model', required=True)
parser.add_argument('--audio')
parser.add_argument('--serve', action='store_true')
args = parser.parse_args()
model = WhisperModel(args.model, device='cpu', compute_type='int8', cpu_threads=4, local_files_only=True)

def transcribe(file):
    audio = decode_audio(file, sampling_rate=16000)
    if len(audio) > 125 * 16000:
        raise ValueError('Recording exceeds two minutes')
    segments, info = model.transcribe(audio, task='transcribe', vad_filter=True, beam_size=5, condition_on_previous_text=False)
    return {'text': ' '.join(segment.text.strip() for segment in segments).strip()}

if args.serve:
    print(json.dumps({'ready': True}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            print(json.dumps(transcribe(request['audio']), ensure_ascii=False), flush=True)
        except Exception:
            print(json.dumps({'error': 'Local transcription could not finish.'}), flush=True)
elif args.audio:
    print(json.dumps(transcribe(args.audio), ensure_ascii=False))
else:
    parser.error('--audio is required unless --serve is selected')
