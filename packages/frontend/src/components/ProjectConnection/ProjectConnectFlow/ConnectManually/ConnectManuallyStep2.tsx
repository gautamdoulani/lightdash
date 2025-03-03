import { WarehouseTypes } from '@lightdash/common';
import { FC } from 'react';
import { CreateProjectConnection } from '../..';
import {
    BackButton,
    CreateHeaderWrapper,
} from '../../../../pages/CreateProject.styles';
import { Title } from '../ProjectConnectFlow.styles';
import { getWarehouseLabel } from '../SelectWarehouse';

interface ConnectManuallyStep2Props {
    isCreatingFirstProject: boolean;
    selectedWarehouse: WarehouseTypes;
    onBack: () => void;
}

const ConnectManuallyStep2: FC<ConnectManuallyStep2Props> = ({
    isCreatingFirstProject,
    selectedWarehouse,
    onBack,
}) => {
    return (
        <>
            <CreateHeaderWrapper>
                <BackButton icon="chevron-left" text="Back" onClick={onBack} />

                <Title>
                    Create a {getWarehouseLabel(selectedWarehouse).label}{' '}
                    connection
                </Title>
            </CreateHeaderWrapper>

            <CreateProjectConnection
                isCreatingFirstProject={isCreatingFirstProject}
                selectedWarehouse={selectedWarehouse}
            />
        </>
    );
};

export default ConnectManuallyStep2;
