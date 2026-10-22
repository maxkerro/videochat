Pod::Spec.new do |s|
  s.name           = 'ProximityScreen'
  s.version        = '1.0.0'
  s.summary        = 'Screen off against the ear during audio calls (CHAT-083).'
  s.description    = 'Toggles UIDevice proximity monitoring for earpiece audio calls.'
  s.author         = ''
  s.homepage       = 'https://example.invalid/videochat'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,swift}'
end
