import Foundation

/// 지금 창에 열려 있는 시트 종류(승인 창 제외)
public enum SheetKind: Sendable, Equatable {
    case none
    /// 공유 파일 미리보기
    case preview
    /// 바뀐 내용 시트
    case update
    /// 입력 시트(사용자가 쓰는 중일 수 있다)
    case form
    /// 확인 시트(사용자가 결정하는 중일 수 있다)
    case confirm
}

/// 승인 요청이 왔을 때 열려 있는 시트를 어떻게 할지
public enum ApprovalAction: Sendable, Equatable {
    /// 열린 시트가 없다: 바로 승인 창
    case showNow
    /// 읽기만 하는 시트: 닫고 바로 승인 창
    case closeSheetThenShow
    /// 입력·결정 중일 수 있는 시트: 닫지 않고 띠로 알린다. 그 시트가 닫히면 승인 창
    case waitWithBanner
}

public enum SheetPolicy {
    public static let bannerText = "승인 요청이 있어요 · 지금 창을 닫으면 떠요"

    public static func onApproval(open: SheetKind) -> ApprovalAction {
        switch open {
        case .none: .showNow
        case .preview, .update: .closeSheetThenShow
        case .form, .confirm: .waitWithBanner
        }
    }
}
