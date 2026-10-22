Pod::Spec.new do |s|
  s.name           = 'VideoBlur'
  s.version        = '1.0.0'
  s.summary        = 'Background blur for the camera in calls (CHAT-084).'
  s.description    = 'A react-native-webrtc frame processor that blurs the background using Vision person segmentation.'
  s.author         = ''
  s.homepage       = 'https://example.invalid/videochat'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'livekit-react-native-webrtc'
  s.frameworks     = 'Vision', 'CoreImage', 'CoreVideo'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,swift}'
end
