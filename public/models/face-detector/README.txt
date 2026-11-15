Local face tracking assets

blaze_face_short_range.tflite is the MediaPipe BlazeFace short-range model from:
https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite

The wasm files are from @mediapipe/tasks-vision 1.2.3 (Apache-2.0):
https://www.npmjs.com/package/@mediapipe/tasks-vision

These files run in the desktop web view. Camera frames are processed locally and
are not transmitted to Alpha's service or to a remote API.
